"""
DynamoDB helpers shared across handlers.

`scan_all` exists because `Limit` on a scan caps the items *evaluated per
page*, not the items returned in total. A handler that does
`scan(Limit=200)` and reads `Items` silently returns a partial table once
the data outgrows a page -- and a reference library that quietly omits
guidelines is worse than a slow one, because the omission looks exactly
like "no such protocol".

`src/protocol/browse.py` and `src/drug/browse.py` each predate this and
carry their own `_scan_all`. They are identical to this one and work; they
should migrate here the next time either is touched, rather than being
changed while the demo depends on them.
"""


def scan_all(table, **kwargs) -> list:
    """Every item in a table, following LastEvaluatedKey to the end.

    Fine at seed scale (71 protocols, 69 drugs) and already the documented
    first thing to replace with a real index if either table grows.
    """
    items, start_key = [], None
    while True:
        page = table.scan(**kwargs, **({"ExclusiveStartKey": start_key} if start_key else {}))
        items.extend(page.get("Items", []))
        start_key = page.get("LastEvaluatedKey")
        if not start_key:
            return items
