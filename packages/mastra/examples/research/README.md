# Research agent

This is the research agent from submilli-runtime's harness tutorials, rewritten to use
`@submilli/mastra`. It answers questions by searching the web and reading pages, and it keeps
a notebook for each user on the server.

`blueprint.yaml`, `prompt.txt`, and `note.ts` are copies of the files in submilli-runtime's
`examples/harnesses/`.

## Run it

Start a server with this directory's Blueprint. From `packages/mastra`, with `submilli` and
`submilli-server` on `PATH` (or in `$SUBMILLI_BIN`) and real Jina and Anthropic keys:

```sh
export SUBMILLI_SERVER_TOKEN=$(openssl rand -hex 32)
JINA_API_KEY=... ANTHROPIC_API_KEY=... scripts/test-server.sh &
export SUBMILLI_SERVER=http://127.0.0.1:8128
ANTHROPIC_API_KEY=... node --conditions=submilli-source examples/research/agent.ts
```

To ask your own question, pass it as arguments to `agent.ts`. In your own project, where
`@submilli/mastra` comes from npm, leave out `--conditions=submilli-source`.

## Check it without a model

```sh
npm run example:check
```

`check.ts` runs the agent with a scripted model in place of Claude, so it needs no API key.
It asserts that two users who write the same note each see only their own. The user is the
memory resource of each agent run, and each memory thread keeps its Submilli session in its
metadata.
