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

`lswebui/server.py` owns HTTP routing, request validation, and calls to the
LightStage client. `lswebui/sequence_files.py` validates uploaded JSON/CBOR data
before constructing playback models and bounds Zstandard expansion.

The browser uses native ES modules without a build step. `api.js` is the HTTP
boundary; the control modules own their forms and pending operations. `scene.js`
owns fixture state shared by the Canvas 2D and WebGPU renderers. The preview shows
locally acknowledged commands, not a live readback of hardware state. A failed
multi-fixture command may have partially executed; commands must not be retried
automatically.

Run `pytest` for the unit suite. Browser regressions in
`tests/test_lswebui_browser.js` run through a temporary HTTP server and an isolated
headless Firefox profile; they skip when Firefox is not installed. They exercise
actual ES modules and DOM events, including pending commands, validation, picking,
and application startup. Neither HTTP nor browser tests require stage hardware.
