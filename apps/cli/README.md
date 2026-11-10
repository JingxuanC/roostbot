# roost-cli

Connect a local computer to a Roost workspace.

```bash
npm install -g roost-cli
roost setup
```

If the registry package is not published yet:

```bash
npm install -g ./roost-cli-0.1.0.tgz
```

`roost` stores its state under `~/.roost` and runs `roostd` locally.
Model credentials stay local; only workspace metadata and execution jobs reach Roost.

See <https://roostbots.com> and `docs/design/local-computer.md` in the main repository.
