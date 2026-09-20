#!/usr/bin/env python3
"""
Loads the demo drug-reference and protocol datasets into DynamoDB after
`sam deploy`. Run once per environment:

    python3 seed_tables.py --stage dev --region us-east-1

Reads table names from CloudFormation stack outputs so you don't have to
hardcode them.

Separately, refresh drug-class data from NLM RxClass into the seed file:

    python3 seed_tables.py --refresh-classes

That writes `classes` / `contraindicated_classes` into
`drug_reference_seed.json` and touches nothing else -- review the diff,
then seed normally. It deliberately does *not* write to DynamoDB and does
*not* touch `contraindicated_with`: the curated pairs are hand-authored
clinical content and RxClass is not allowed to delete them. See
`common/drugs.py` for why that merge direction matters.
"""
import argparse
import json
import pathlib
import sys
import boto3

HERE = pathlib.Path(__file__).parent
DRUG_SEED = HERE / "drug_reference_seed.json"


def get_stack_outputs(stack_name: str, region: str) -> dict:
    cf = boto3.client("cloudformation", region_name=region)
    resp = cf.describe_stacks(StackName=stack_name)
    outputs = resp["Stacks"][0].get("Outputs", [])
    return {o["OutputKey"]: o["OutputValue"] for o in outputs}


def refresh_classes() -> int:
    """Pull MoA/EPC classes from RxClass into the drug seed file.

    Alias rows are skipped: they carry no clinical content of their own and
    resolve to a real record that does.
    """
    sys.path.insert(0, str(HERE))
    import rxclass

    drugs = json.loads(DRUG_SEED.read_text())
    changed = 0
    for item in drugs:
        name = item["drug_name"]
        if item.get("alias_of"):
            continue
        try:
            classes, contraindicated = rxclass.classes_for(name)
        except Exception as e:  # noqa: BLE001 -- one bad lookup must not
            print(f"  {name:16} LOOKUP FAILED ({e}) -- leaving as-is")
            continue        # discard classes already reviewed and committed
        if not classes and not contraindicated:
            print(f"  {name:16} no MoA/EPC classes in RxClass -- leaving as-is")
            continue
        before = (item.get("classes"), item.get("contraindicated_classes"))
        item["classes"] = classes
        item["contraindicated_classes"] = contraindicated
        if before != (classes, contraindicated):
            changed += 1
        print(f"  {name:16} is={len(classes):2}  ci={len(contraindicated):2}"
              f"  {[c['class_name'] for c in contraindicated]}")

    DRUG_SEED.write_text(json.dumps(drugs, indent=2) + "\n")
    print(f"\nUpdated {changed} record(s) in {DRUG_SEED.name}.")
    print("Review the diff, then run without --refresh-classes to seed DynamoDB.")
    return changed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", default="dev")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--stack-name", default=None, help="Defaults to ems-copilot-<stage>")
    parser.add_argument(
        "--refresh-classes", action="store_true",
        help="Refresh drug classes from NLM RxClass into the seed file, then exit. "
             "Makes no AWS calls.")
    args = parser.parse_args()

    if args.refresh_classes:
        refresh_classes()
        return

    stack_name = args.stack_name or f"ems-copilot-{args.stage}"
    dynamodb = boto3.resource("dynamodb", region_name=args.region)

    drug_table = dynamodb.Table(f"ems-copilot-drug-reference-{args.stage}")
    protocol_table = dynamodb.Table(f"ems-copilot-protocols-{args.stage}")

    drugs = json.loads(DRUG_SEED.read_text())
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
