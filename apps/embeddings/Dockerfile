# Runtime image: HuggingFace TEI + the prebuilt Qwen3-Embedding-4B weights image.
#
# The weights are NOT downloaded here — they come from the separately-built, cached
# `embeddings-weights` image (Dockerfile.weights) as a named build stage. That keeps iterating on
# the TEI base cheap: swapping TEI_IMAGE re-pulls only the runtime base + copies the weight layer
# from AR (an in-GCP transfer), instead of re-downloading ~8GB from HuggingFace each rebuild.
#
# TEI_IMAGE is a build-arg because the correct tag is driver-sensitive: Cloud Run's L4 driver
# (535.216.03 / CUDA 12.2) can only JIT PTX up to CUDA 12.2. TEI 1.9+ is built on CUDA 12.9 and
# fails at model load with CUDA_ERROR_UNSUPPORTED_PTX_VERSION (cast_bf16_f16); 89-1.8 (CUDA 12.2,
# cc8.9/Ada, Qwen3-4B-capable) is the compatible pin. Set via cloudbuild.yaml _TEI_IMAGE.
ARG WEIGHTS_IMAGE
ARG TEI_IMAGE

FROM ${WEIGHTS_IMAGE} AS weights

FROM ${TEI_IMAGE}
COPY --from=weights /models/qwen3-embed /models/qwen3-embed
# Serve strictly from the baked local path — no network at boot.
ENV HF_HUB_OFFLINE=1
# Default args for `docker run`; deploy.sh passes the authoritative set via Cloud Run --args.
# --dtype float16: this TEI build accepts only {float16,float32} (not bfloat16).
CMD ["--model-id", "/models/qwen3-embed", \
     "--dtype", "float16", \
     "--auto-truncate", \
     "--port", "8080"]
