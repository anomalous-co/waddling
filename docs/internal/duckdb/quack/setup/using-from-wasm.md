# Quack on WebAssembly

This page explains how to deploy a Quack server accessible from DuckDB-Wasm via a CloudFormation stack.

## CloudFormation Stack

We provide an example template for initializing a CloudFormation stack, based on a pre-baked public AMI (Ubuntu), which will:

- Via DuckDB, install and load Quack, create a randomized token, and do `quack_serve` on the `0.0.0.0:1294` port.
- Set up via nginx a proxy between `0.0.0.0:1294` and the incoming `:443` port.
- Obtain a valid TLS certificate via Let's Encrypt.

All together, this allows exposing the local `0.0.0.0:1294` port to the public EC2 instance IP via HTTPS.

The template is reachable at:

```
https://duckdb-quack-ami.s3.us-east-1.amazonaws.com/quack.yaml
```

It is backed by images for (at the moment) eight regions:

- `us-east-1`
- `us-east-2`
- `us-west-1`
- `us-west-2`
- `eu-central-1`
- `eu-west-1`
- `ap-northeast-1`
- `ap-southeast-1`

Only inputs are the type of the instance (default `t3.micro`) and the name of the stack (needs to be unique on the same org/region).

The template is maintained at [github.com/duckdb/duckdb-quack-infra](https://github.com/duckdb/duckdb-quack-infra).

## Deploy via Web UI

1. Visit the [Quick Create Stack URL](https://console.aws.amazon.com/cloudformation/home#/stacks/quickcreate?templateURL=https://duckdb-quack-ami.s3.us-east-1.amazonaws.com/quack.yaml&stackName=my-duckdb-quack-demo).
2. Log in, select a name, possibly an instance class, and click **Launch Stack**.

> **Warning:** This will incur billing. Make sure you check the stack page afterward, and delete any stacks that are no longer relevant.

## Deploy via AWS CLI

To deploy a Quack demo with the name `my-quack-demo` in the `us-east-2` region, run:

```bash
aws cloudformation create-stack \
  --stack-name my-quack-demo \
  --template-url https://duckdb-quack-ami.s3.us-east-1.amazonaws.com/quack.yaml \
  --region us-east-2
```

Wait approximately 2 minutes for the deployment to complete (this command is blocking):

```bash
aws cloudformation wait stack-create-complete \
  --stack-name my-quack-demo \
  --region us-east-2
```

Consult the auto-generated outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name my-quack-demo \
  --region us-east-2 \
  --query 'Stacks[0].Outputs' \
  --output table
```

Now you can visit the relevant link, which will encode connecting to the just-created Quack server via DuckDB-Wasm.

## Destroy

```bash
aws cloudformation delete-stack \
  --stack-name my-quack-demo \
  --region us-east-2
```

## Web UI

To see the status of your CloudFormation stack on the AWS web user interface, visit the [CloudFormation console](https://console.aws.amazon.com/cloudformation).
