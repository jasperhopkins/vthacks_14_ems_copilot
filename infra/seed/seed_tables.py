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
NASEMSO_SEED = HERE / "nasemso_protocol_seed.json"
DEMO_SEED = HERE / "protocol_reference_seed.json"


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


def refresh_labels() -> int:
    """Mine openFDA labelling into `label_contraindications` on each record.

    Writes only that field. Curated pairs, doses and RxClass data are
    untouched -- three independent sources that the interaction checker
    merges at read time, rather than one that overwrites the others.
    """
    sys.path.insert(0, str(HERE))
    import openfda

    drugs = json.loads(DRUG_SEED.read_text())
    known = openfda.known_drug_spellings(drugs)
    total = 0

    for item in drugs:
        if item.get("alias_of"):
            continue
        name = item["drug_name"]
        try:
            picked = openfda.select_label(name, openfda.fetch_labels(name))
        except Exception as e:  # noqa: BLE001 -- one bad lookup must not
            print(f"  {name:22} LOOKUP FAILED ({e})")
            continue           # discard rows already reviewed and committed
        if not picked:
            print(f"  {name:22} no single-ingredient label with a "
                  f"contraindications section")
            continue
        _, label, sections = picked
        rows = openfda.extract(item, sections, label.get("set_id", ""), known)
        if rows:
            item["label_contraindications"] = rows
            total += len(rows)
            targets = ", ".join(f"{r['kind']}:{r['target']}" for r in rows)
            print(f"  {name:22} {len(rows):2} -> {targets[:88]}")
        else:
            item.pop("label_contraindications", None)

    DRUG_SEED.write_text(json.dumps(drugs, indent=2, ensure_ascii=False) + "\n")
    print(f"\n{total} label-derived contraindication row(s) in {DRUG_SEED.name}.")
    print("Every row carries the verbatim sentence and its DailyMed set id.")
    print("Review the diff, then run without --refresh-labels to seed DynamoDB.")
    return total


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", default="dev")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--stack-name", default=None, help="Defaults to ems-copilot-<stage>")
    parser.add_argument(
        "--refresh-classes", action="store_true",
        help="Refresh drug classes from NLM RxClass into the seed file, then exit. "
             "Makes no AWS calls.")
    parser.add_argument(
        "--refresh-labels", action="store_true",
        help="Mine FDA labelling (openFDA) for contraindications into the seed "
             "file, then exit. Makes no AWS calls.")
    parser.add_argument(
        "--demo-protocols", action="store_true",
        help="Seed the three hand-written demo protocols instead of the 71 "
             "extracted NASEMSO guidelines.")
    args = parser.parse_args()

    if args.refresh_classes:
        refresh_classes()
        return

    if args.refresh_labels:
        refresh_labels()
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

    # NASEMSO by default. The two sets are deliberately NOT merged: both
    # cover anaphylaxis, opioid overdose and chest pain, and seeding both
    # would put two competing protocols in front of a medic for the same
    # presentation. The demo file stays in the repo as the fixture
    # test_protocol_search.py scores against.
    source = DEMO_SEED if args.demo_protocols else NASEMSO_SEED
    if not source.exists():
        sys.exit(f"{source.name} not found -- run ingest_nasemso.py first, "
                 f"or pass --demo-protocols.")
    protocols = json.loads(source.read_text())

    # protocol_id is the partition key, so a stale record from the other set
    # would survive a re-seed and keep answering queries. Clear first.
    existing = protocol_table.scan(ProjectionExpression="protocol_id").get("Items", [])
    stale = [p["protocol_id"] for p in existing
             if p["protocol_id"] not in {r["protocol_id"] for r in protocols}]
    if stale:
        with protocol_table.batch_writer() as batch:
            for pid in stale:
                batch.delete_item(Key={"protocol_id": pid})
        print(f"Removed {len(stale)} protocol record(s) not in {source.name}")

    with protocol_table.batch_writer() as batch:
        for item in protocols:
            batch.put_item(Item=item)
    print(f"Seeded {len(protocols)} protocol records from {source.name} "
          f"into {protocol_table.table_name}")


if __name__ == "__main__":
    main()
