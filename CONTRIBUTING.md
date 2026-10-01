# Contributing

```shell
git clone https://github.com/lightstageurop/pylightstage.git
cd pylightstage
```

## Install (dev) and test

The default pytest suite excludes `integration` tests that require an active `lsserver` WebSocket endpoint. Integration tests alter fixture states; be cautious when running on real hardware.

### Using `venv` and `pip`

```shell
# create and activate venv
python3 -m venv .venv
. .venv/bin/activate    # On Windows: .venv\Scripts\activate

# Install with dev dependencies (eg. pytest)
pip install -e .
pip install --group dev

# Run default unit tests
pytest

# Run integration tests against a real server
pytest -m "integration"

# Or, run all tests
pytest -m ""

# Using lscli with local server
lscli --uri=ws://127.0.0.1:8080/ws
```

### Using [`uv`][uv]

```shell
# Install project with dev dependencies
uv sync

# prefix commands with 'uv run'
uv run pytest
uv run pytest -m ""
uv run lscli --uri=ws://127.0.0.1:8080/ws
```

[uv]: https://docs.astral.sh/uv/

## Architecture

### Project structure

```text
src/
└── pylightstage/
    ├── lscli/
    │   ├── __init__.py     # lscli parser, dispatch, entrypoint
    │   ├── __main__.py     # stub for lscli:main
    │   └── interactive.py  # lscli interactive
    ├── __init__.py         # public re-exports
    ├── client.py           # LightStageClient, LightStageSyncClient
    ├── models.py           # dataclasses for modes, config, sequences
    ├── sequences.py        # SequenceBuilder
    └── utils.py            # common validation
examples/   # Runnable examples for users
tests/       # pytest tests
```

## Backwards compatibility

Some choices were made to maintain compatibility, or at least make the API feel mostly familiar to the old `lightstage.py` library.

- Methods like `turn_on_*`/`turn_off_*` are kept as aliases for the new `set_*`/`clear_*` methods.
- We preserved intensities as an 8-bit range (0.0-255.0) in the public API, and convert them to 16-bit expected by the new WebSocket API.

These are not hard rules and we do not make any promises about perfect backwards compatibility. Breaking changes could be made in later major releases.

## lswebui

`lswebui/config.py` owns validated launcher settings. `lswebui/server.py` owns
HTTP routing, bounded request bodies, response encoding, and the static asset
allowlist. `lswebui/commands.py` validates hardware commands before opening a
LightStage client session. `lswebui/sequence_files.py` validates uploaded JSON/CBOR data
before constructing playback models and bounds Zstandard expansion.
`lswebui/environment_files.py` uses OpenImageIO to decode professional panoramas,
converts source colour spaces and integrates original linear pixels for IBL.
The browser receives latitude integrals and a separate tone-mapped thumbnail;
controls continue to sample locally without repeating native decoding.

The browser uses native ES modules without a build step. `app.js` wires the
components together. `api.js` is the HTTP boundary; `connectivity.js` serializes
status checks, and `inspector.js` owns explicit server queries. `viewport.js`
owns renderer selection, camera interaction, and WebGPU fallback. The control
modules own their forms and pending operations. `dom.js` provides shared status
and element helpers. `scene.js`
owns fixture state shared by the Canvas 2D and WebGPU renderers. The preview shows
locally acknowledged commands, not a live readback of hardware state. A failed
multi-fixture command may have partially executed; commands must not be retried
automatically.

Keep new browser modules in the server's explicit asset allowlist. Package data
includes top-level JavaScript and renderer modules. Shared field colours and
focus styles live at the start of `styles.css`; component styles follow in
labelled sections. Preserve `[hidden]`, keyboard focus, reduced-motion support,
and the desktop/mobile layout checks when editing styles.

The launcher filters the redundant `atk-bridge` entry from `GTK_MODULES` only
while opening the default browser, then restores the original environment even
if launching fails. Other GTK modules and browser diagnostics remain enabled.

Run `pytest` for the unit suite. Browser regressions in
`tests/test_lswebui_browser.js` run through a temporary HTTP server and an isolated
headless Firefox profile; they skip when Firefox is not installed. They exercise
actual ES modules and DOM events, including pending commands, validation, picking,
and application startup. Neither HTTP nor browser tests require stage hardware.
