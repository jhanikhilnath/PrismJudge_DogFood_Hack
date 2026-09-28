import os
import re

files = [
    'README.md',
    'JUDGING.md',
    'docs/PRESENTATION.md',
    'ARCHITECTURE.md',
    'CONTEXT.md',
    'DATA-MODEL.md',
    'docs/DECISIONS.md',
    'docs/BACKUP-DR.md',
    'SECURITY.md',
    'AGENTS.md',
    'IMPLEMENTATION_PLAN.md'
]

for filename in files:
    if not os.path.exists(filename):
        continue
    with open(filename, 'r', encoding='utf-8') as f:
        content = f.read()

    # Remove code fences ```...```
    no_code = re.sub(r'```.*?```', '', content, flags=re.DOTALL)
    no_code = re.sub(r'`[^`\n]+`', '', no_code)

    # Find block math $$...$$
    block_math = []
    for match in re.finditer(r'\$\$(.*?)\$\$', no_code, flags=re.DOTALL):
        block_math.append(match.group(1))

    # Remove block math
    no_blocks = re.sub(r'\$\$.*?\$\$', '', no_code, flags=re.DOTALL)

    # Find inline math $...$
    inline_math = []
    for match in re.finditer(r'(?<!\$)\$([^\$\n]+)\$(?!\$)', no_blocks):
        inline_math.append(match.group(1))

    print(f"\n==========================================")
    print(f"FILE: {filename}")
    print(f"Block equations: {len(block_math)}")
    print(f"Inline equations: {len(inline_math)}")

    for i, eq in enumerate(block_math, 1):
        clean = eq.strip()
        issues = []
        if '*' in clean:
            issues.append("Raw asterisk '*' found (risk of markdown italics parsing)")
        if clean.count('{') != clean.count('}'):
            issues.append(f"Braces unbalanced: {clean.count('{')} open vs {clean.count('}')} close")
        if clean.count('(') != clean.count(')'):
            issues.append(f"Parens unbalanced: {clean.count('(')} open vs {clean.count(')')} close")
        if clean.count('[') != clean.count(']'):
            issues.append(f"Brackets unbalanced: {clean.count('[')} open vs {clean.count(']')} close")

        status = "FAIL" if issues else "OK"
        print(f"  [BLOCK {i}] [{status}] {clean[:70]}...")
        for issue in issues:
            print(f"      -> ISSUE: {issue}")

    for i, eq in enumerate(inline_math, 1):
        clean = eq.strip()
        issues = []
        if '*' in clean:
            issues.append("Raw asterisk '*' found (risk of markdown italics parsing)")
        if clean.count('{') != clean.count('}'):
            issues.append(f"Braces unbalanced: {clean.count('{')} open vs {clean.count('}')} close")
        if clean.count('(') != clean.count(')'):
            issues.append(f"Parens unbalanced: {clean.count('(')} open vs {clean.count(')')} close")
        if clean.count('[') != clean.count(']'):
            issues.append(f"Brackets unbalanced: {clean.count('[')} open vs {clean.count(']')} close")

        status = "FAIL" if issues else "OK"
        if status == "FAIL" or len(issues) > 0:
            print(f"  [INLINE {i}] [{status}] {clean}")
            for issue in issues:
                print(f"      -> ISSUE: {issue}")
