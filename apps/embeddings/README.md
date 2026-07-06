# apps/embeddings — self-hosted text-embedding GPU service

A private, scale-to-zero Cloud Run **L4 GPU** service that serves **Qwen3-Embedding-4B**
(HuggingFace weights, self-hosted — not Vertex/Google embeddings). It is the embedding backend
for the Quackboard context graph: memories and observations are embedded into vectors, and
similarity over those vectors produces the semantic edges.

## Contract

- **`POST /embed`** — `{"inputs": "text"}` or `{"inputs": ["t1","t2",…]}` → `[[...floats...], …]`
- **`POST /v1/embeddings`** — OpenAI-compatible: `{"input": …, "encoding_format": "float"}`
- **`GET /health`**
- **Output dimension: `2560`** (Qwen3-Embedding-4B `hidden_size`). This is the FIXED width of the
  downstream `embeddings.vec FLOAT[2560]` column. The model supports Matryoshka truncation
  (32–2560); if a smaller variant is ever stored it is a *separate* column, never mixed.

### Asymmetric retrieval (important for callers)
Qwen3-Embedding is instruction-tuned. **Queries** should be prefixed:
`Instruct: {task}\nQuery:{text}`; **documents/memories are embedded raw** (no prefix).
Omitting the query instruction costs ~1–5% retrieval quality. TEI does not apply the template
implicitly on `/embed` — the caller prepends it for query-side embeds.

## Why these choices

- **TEI** (`ghcr.io/huggingface/text-embeddings-inference:89-1.9`, the Ada/compute-8.9 build for
  L4) over vLLM: purpose-built for embeddings, natively supports the Qwen3 architecture, smaller
  image, no generation stack.
- **Weights baked into the image** with `HF_HUB_OFFLINE=1`: a scale-to-zero cold start must never
  fetch ~8GB from the hub. The model is public (Apache-2.0) so the build needs no HF token. Trade:
  ~10GB image, cached regionally by Cloud Run across cold starts. The weights live in a SEPARATE,
  cached `embeddings-weights:qwen3-4b` image (`Dockerfile.weights`) that the runtime `Dockerfile`
  COPYs from — so swapping the TEI base (e.g. for the driver pin below) is a fast in-GCP assembly,
  not a repeated 8GB HuggingFace download.
- **TEI `89-1.8` (CUDA 12.2), NOT 1.9+**: Cloud Run's L4 driver is 535.216.03 / CUDA 12.2. TEI 1.9+
  is built on CUDA 12.9 and dies at model load with `CUDA_ERROR_UNSUPPORTED_PTX_VERSION` (the driver
  can't JIT the newer PTX; `--dtype float16` doesn't dodge it — the bf16→f16 cast kernel is always
  compiled). Do not bump past 1.8 until Google raises the managed driver.
- **`bfloat16`**: the model's native training dtype; L4/Ada supports it. ~8GB VRAM, fits the 24GB
  L4 comfortably.
- **us-central1** service region: Cloud Run GPU L4 is only offered in
  `{asia-southeast1, europe-west4, europe-west1, us-central1, us-east4}` — **not us-west1** where
  the rest of the stack runs. The image registry stays in us-west1 (cross-region pull is fine);
  only the GPU service is remote. Callers reach it async, so the cross-region hop is immaterial.
- **`--no-gpu-zonal-redundancy`**: cheaper best-effort mode, and the mode auto-granted 3 GPUs of
  Cloud Run quota on first regional use (no quota request). Cloud Run's managed L4 quota
  (`run.googleapis.com/nvidia_l4_gpu_allocation_no_zonal_redundancy`) is SEPARATE from the
  Compute Engine `NVIDIA_L4_GPUS` quota.

## The async invariant

Cold start is **tens of seconds** (image materialization + model load into VRAM). Embedding is
therefore **always async — never in an agent write path**. `qb_observe`/`qb_remember` only leave
rows un-embedded; a background/nightly job (Phase 3) drains them through this service. If bounded
latency is ever required, set `--min-instances=1` (defeats scale-to-zero, costs a resident GPU)
rather than gambling on a cold start.

## Ops

Builds run on **GCP Cloud Build, never locally** (a ~10GB weight-baking image fills a laptop disk).

```bash
# one-time (only when the MODEL changes) — builds the cached weights image:
gcloud builds submit . --config=cloudbuild.weights.yaml

# runtime image (fast: pulls cached weights + TEI base in-GCP) + deploy to the L4 GPU service:
./deploy.sh          # gcloud builds submit (cloudbuild.yaml) → us-west1 AR → deploy us-central1 GPU
./smoke.sh           # proxy in (private service) + measure dim / cold-start / throughput
```

Live service: `embeddings` @ us-central1 (L4, scale-to-zero, private). Verified: `/embed` and
`/v1/embeddings` return dim 2560; warm batch ~130ms.

Private service: callers need `roles/run.invoker` + a Google ID token. Phase 3 grants invoker to
the gateway and control-api service accounts when it wires the embed pipeline. `smoke.sh` uses
`gcloud run services proxy` (your gcloud identity) to reach it without a public URL.
