"""定位私有出题备忘录。current 输出本次写入路径，find 按题目或工作流 ID 找已保存的版本。只读。"""

import argparse
import hashlib
import json
import re
from pathlib import Path
from uuid import UUID


def memo_name(question_id):
    digest = hashlib.sha256(question_id.encode("utf-8")).hexdigest()
    return f"design-memo-{digest}.json"


def current_path(delivery):
    with delivery.open(encoding="utf-8") as source:
        result = Path(json.load(source)["result_path"])
    with delivery.with_name("input.json").open(encoding="utf-8") as source:
        question_id = json.load(source)["question_id"]
    return result.with_name(memo_name(question_id))


def find_paths(storage, identifier):
    suffix = "*/private/authoring-*/author/output"
    roots = []
    try:
        workflow = UUID(identifier)
    except ValueError:
        if re.fullmatch(r"[0-9a-fA-F]{8}", identifier):
            for path in storage.glob(identifier.lower() + "-*"):
                try:
                    UUID(path.name)
                except ValueError:
                    continue
                if path.is_dir():
                    roots.append(path)
            if len(roots) > 1:
                choices = "、".join(sorted(path.name for path in roots))
                raise ValueError(f"此短 ID 对应多个工作流，请用完整 UUID 重查：{choices}")
    else:
        roots.append(storage / str(workflow))
    matches = set(storage.glob(f"*/{suffix}/{memo_name(identifier)}"))
    for root in roots:
        matches.update(root.glob(f"{suffix}/design-memo-*.json"))
    return sorted(path for path in matches if path.is_file())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    modes.add_parser("current").add_argument("delivery", type=Path)
    find = modes.add_parser("find")
    find.add_argument("storage", type=Path)
    find.add_argument("identifier")
    args = parser.parse_args()
    if args.mode == "current":
        print(current_path(args.delivery))
        return 0
    try:
        paths = find_paths(args.storage.resolve(), args.identifier)
    except ValueError as error:
        parser.exit(2, f"{error}\n")
    for path in paths:
        print(path)
    if not paths:
        parser.exit(1, "没有找到此 ID 对应的已保存备忘录。\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
