#!/usr/bin/env python3
"""
Loads the demo drug-reference and protocol datasets into DynamoDB after
`sam deploy`. Run once per environment:

    python3 seed_tables.py --stage dev --region us-east-1

Reads table names from CloudFormation stack outputs so you don't have to
hardcode them.
"""
import argparse
import json
import pathlib
import boto3

HERE = pathlib.Path(__file__).parent


def get_stack_outputs(stack_name: str, region: str) -> dict:
    cf = boto3.client("cloudformation", region_name=region)
    resp = cf.describe_stacks(StackName=stack_name)
    outputs = resp["Stacks"][0].get("Outputs", [])
    return {o["OutputKey"]: o["OutputValue"] for o in outputs}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", default="dev")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--stack-name", default=None, help="Defaults to ems-copilot-<stage>")
    args = parser.parse_args()

    stack_name = args.stack_name or f"ems-copilot-{args.stage}"
    dynamodb = boto3.resource("dynamodb", region_name=args.region)

    drug_table = dynamodb.Table(f"ems-copilot-drug-reference-{args.stage}")
    protocol_table = dynamodb.Table(f"ems-copilot-protocols-{args.stage}")

    drugs = json.loads((HERE / "drug_reference_seed.json").read_text())
    with drug_table.batch_writer() as batch:
        for item in drugs:
            batch.put_item(Item=item)
    print(f"Seeded {len(drugs)} drug reference records into {drug_table.table_name}")

    protocols = json.loads((HERE / "protocol_reference_seed.json").read_text())
    with protocol_table.batch_writer() as batch:
        for item in protocols:
            batch.put_item(Item=item)
    print(f"Seeded {len(protocols)} protocol records into {protocol_table.table_name}")


if __name__ == "__main__":
    main()
