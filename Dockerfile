FROM node:26.11.1-bookworm-slim
WORKDIR /lab
COPY examples/research-workbench/src ./examples/research-workbench/src
COPY examples/research-workbench/fixtures ./examples/research-workbench/fixtures
COPY examples/research-workbench/web ./examples/research-workbench/web
CMD ["node", "examples/research-workbench/src/cli.mjs", "demo"]
