# chatgpt-queue-optimizer agent instructions

Inherit the vault-root AGENTS.md.

<!-- project-memory-bootstrap:v1 -->
## Memory bank bootstrap (technical name: project-memory)

From this project root, only when you cannot tell which code owns the behavior, run:

```bash
python3 ../../scripts/project-memory-context.py --root . --task "<current task>"
```

Do not read every Required source reads path before a normal edit. Read the files you will change. A loader failure does not block a product edit. Edit durable tasks and memory only at contract-listed paths.
<!-- /project-memory-bootstrap:v1 -->

# Git

- Always commit and merge to main for changes. Use `/sync` if push is not clean.
