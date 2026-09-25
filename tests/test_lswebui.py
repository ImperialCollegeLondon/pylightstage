"""Unit tests for the local LightStage web interface framework."""

import http.client
import json
import re
import threading
from io import StringIO
from urllib.parse import urljoin

import pytest

from pylightstage.lscli import DEFAULT_URI
from pylightstage.lswebui import DEFAULT_BIND, DEFAULT_PORT, ServerConfig, run
from pylightstage.lswebui.server import (
    _apply_fixture_control,
    _inspect_server,
    _mode_command,
    create_server,
)

pytestmark = pytest.mark.unit


class InterruptingServer:
    def __init__(self, config):
        self.config = config
        self.server_address = (config.bind, 45123)
        self.entered = False
        self.closed = False
        self.poll_interval = None

    def __enter__(self):
        self.entered = True
        return self

    def __exit__(self, *_):
        self.closed = True

    def serve_forever(self, poll_interval):
        self.poll_interval = poll_interval
        raise KeyboardInterrupt


def test_command_defaults_match_the_cli_style_and_open_browser():
    servers = []
    opened = []

    def factory(config):
        server = InterruptingServer(config)
        servers.append(server)
        return server

    output = StringIO()
    status = run(
        [], server_factory=factory, browser_opener=opened.append, stdout=output
    )

    assert status == 0
    assert servers[0].config == ServerConfig(
        bind=DEFAULT_BIND,
        port=DEFAULT_PORT,
        lightstage_uri=DEFAULT_URI,
        log_requests=False,
    )
    assert servers[0].entered and servers[0].closed
    assert servers[0].poll_interval == 0.25
    assert opened == ["http://127.0.0.1:45123/"]
    assert "Press Ctrl-C to stop." in output.getvalue()


def test_user_settings_reach_the_server_and_no_browser_is_respected():
    servers = []

    def factory(config):
        server = InterruptingServer(config)
        server.server_address = ("0.0.0.0", 9123)
        servers.append(server)
        return server

    opened = []
    run(
        [
            "--bind",
            "0.0.0.0",
            "--port",
            "9123",
            "--uri",
            "wss://stage.example/ws",
            "--log-requests",
            "--no-browser",
        ],
        server_factory=factory,
        browser_opener=opened.append,
        stdout=StringIO(),
    )

    assert servers[0].config == ServerConfig(
        bind="0.0.0.0",
        port=9123,
        lightstage_uri="wss://stage.example/ws",
        log_requests=True,
    )
    assert opened == []


@pytest.mark.parametrize(
    "config, message",
    [
        (ServerConfig(bind="", port=8000), "bind address"),
        (ServerConfig(port=-1), "port"),
        (ServerConfig(lightstage_uri="http://stage/ws"), "ws:// or wss://"),
    ],
)
def test_invalid_server_configuration_is_rejected(config, message):
    with pytest.raises(ValueError, match=message):
        config.validate()


async def test_fixture_control_uses_the_same_direct_client_operation(monkeypatch):
    actions = []

    class FakeClient:
        def __init__(self, *, uri):
            actions.append(("connect", uri))

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def set_light(self, **kwargs):
            actions.append(("set_light", kwargs))

    monkeypatch.setattr("pylightstage.lswebui.server.LightStageClient", FakeClient)
    config = ServerConfig(lightstage_uri="ws://stage.test/ws")

    await _apply_fixture_control(
        config,
        {
            "action": "set",
            "selector": "direct",
            "arc": 2,
            "light": 5,
            "color": "rgbw",
            "intensity": [12, 34, 56],
        },
    )

    assert actions == [
        ("connect", "ws://stage.test/ws"),
        (
            "set_light",
            {
                "light": 5,
                "arc": 2,
                "color": "rgbw",
                "intensity": (12.0, 34.0, 56.0),
            },
        ),
    ]


async def test_fixture_control_supports_polarized_clear(monkeypatch):
    actions = []

    class FakeClient:
        def __init__(self, *, uri):
            self.uri = uri

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def set_pol_light(self, **kwargs):
            actions.append(kwargs)

    monkeypatch.setattr("pylightstage.lswebui.server.LightStageClient", FakeClient)

    await _apply_fixture_control(
        ServerConfig(),
        {
            "action": "clear",
            "selector": "polarized",
            "arc": 1,
            "light": 3,
            "polarization": "cp",
            "intensity": [255, 255, 255],
        },
    )

    assert actions == [
        {
            "light": 3,
            "arc": 1,
            "pol": "cp",
            "intensity": (0.0, 0.0, 0.0),
        }
    ]


@pytest.mark.parametrize(
    "target, payload, method, expected",
    [
        (
            "arc",
            {"arc": 4},
            "set_arc",
            {
                "arc": 4,
                "color": "w",
                "intensity": (10.0, 20.0, 30.0),
            },
        ),
        (
            "horizontal_arc",
            {"light": 6},
            "set_horizontal_arc",
            {
                "light": 6,
                "color": "w",
                "intensity": (10.0, 20.0, 30.0),
            },
        ),
    ],
)
async def test_fixture_control_supports_direct_group_targets(
    monkeypatch, target, payload, method, expected
):
    actions = []

    class FakeClient:
        def __init__(self, *, uri):
            self.uri = uri

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        def __getattr__(self, name):
            assert name == method

            async def call(**kwargs):
                actions.append(kwargs)

            return call

    monkeypatch.setattr("pylightstage.lswebui.server.LightStageClient", FakeClient)

    await _apply_fixture_control(
        ServerConfig(),
        {
            "action": "set",
            "target": target,
            "selector": "direct",
            "color": "w",
            "intensity": [10, 20, 30],
            **payload,
        },
    )

    assert actions == [expected]


async def test_fixture_control_applies_multiple_mixed_targets(monkeypatch):
    actions = []

    class FakeClient:
        def __init__(self, *, uri):
            self.uri = uri

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def set_light(self, **kwargs):
            actions.append(("fixture", kwargs))

        async def set_arc(self, **kwargs):
            actions.append(("arc", kwargs))

        async def set_horizontal_arc(self, **kwargs):
            actions.append(("horizontal_arc", kwargs))

    monkeypatch.setattr("pylightstage.lswebui.server.LightStageClient", FakeClient)

    await _apply_fixture_control(
        ServerConfig(),
        {
            "action": "clear",
            "selector": "direct",
            "color": "rgb",
            "targets": [
                {"target": "fixture", "arc": 1, "light": 2},
                {"target": "arc", "arc": 3},
                {"target": "horizontal_arc", "light": 4},
                {"target": "arc", "arc": 3},
            ],
        },
    )

    assert actions == [
        (
            "fixture",
            {
                "light": 2,
                "arc": 1,
                "color": "rgb",
                "intensity": (0.0, 0.0, 0.0),
            },
        ),
        (
            "arc",
            {"arc": 3, "color": "rgb", "intensity": (0.0, 0.0, 0.0)},
        ),
        (
            "horizontal_arc",
            {"light": 4, "color": "rgb", "intensity": (0.0, 0.0, 0.0)},
        ),
    ]


@pytest.mark.parametrize(
    "target, payload, varying_key, indices, fixed_key, fixed_value",
    [
        ("arc", {"arc": 3}, "light", range(14), "arc", 3),
        (
            "horizontal_arc",
            {"light": 5},
            "arc",
            range(12),
            "light",
            5,
        ),
    ],
)
async def test_fixture_control_batches_polarized_group_targets(
    monkeypatch, target, payload, varying_key, indices, fixed_key, fixed_value
):
    actions = []

    class FakeClient:
        def __init__(self, *, uri):
            self.uri = uri

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def set_pol_light(self, **kwargs):
            actions.append(("set_pol_light", kwargs))

        async def go(self):
            actions.append(("go", {}))

    monkeypatch.setattr("pylightstage.lswebui.server.LightStageClient", FakeClient)

    await _apply_fixture_control(
        ServerConfig(),
        {
            "action": "set",
            "target": target,
            "selector": "polarized",
            "polarization": "pp",
            "intensity": [1, 2, 3],
            **payload,
        },
    )

    fixture_updates = [
        kwargs for action, kwargs in actions if action == "set_pol_light"
    ]
    assert len(fixture_updates) == len(indices)
    assert {update[varying_key] for update in fixture_updates} == set(indices)
    assert all(update[fixed_key] == fixed_value for update in fixture_updates)
    assert all(update["pol"] == "pp" for update in fixture_updates)
    assert all(update["intensity"] == (1.0, 2.0, 3.0) for update in fixture_updates)
    assert all(update["go"] is False for update in fixture_updates)
    assert actions[-1] == ("go", {})


async def test_fixture_control_deduplicates_overlapping_polarized_targets(monkeypatch):
    updates = []

    class FakeClient:
        def __init__(self, *, uri):
            self.uri = uri

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def set_pol_light(self, **kwargs):
            updates.append(kwargs)

        async def go(self):
            return None

    monkeypatch.setattr("pylightstage.lswebui.server.LightStageClient", FakeClient)

    await _apply_fixture_control(
        ServerConfig(),
        {
            "action": "set",
            "selector": "polarized",
            "polarization": "cp",
            "targets": [
                {"target": "arc", "arc": 3},
                {"target": "horizontal_arc", "light": 5},
                {"target": "fixture", "arc": 3, "light": 5},
            ],
        },
    )

    assert len(updates) == 25
    assert len({(update["arc"], update["light"]) for update in updates}) == 25


@pytest.mark.parametrize(
    "action, method, result",
    [
        ("get-config", "get_config", {"arcs": 12}),
        ("get-mode", "get_mode", "Manual"),
        ("list-sequences", "list_sequences", []),
    ],
)
async def test_server_inspector_calls_read_only_cli_actions(
    monkeypatch, action, method, result
):
    calls = []

    class FakeClient:
        def __init__(self, *, uri):
            calls.append(("connect", uri))

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        def __getattr__(self, name):
            assert name == method

            async def call():
                calls.append(("read", name))
                return result

            return call

    monkeypatch.setattr("pylightstage.lswebui.server.LightStageClient", FakeClient)

    assert (
        await _inspect_server(ServerConfig(lightstage_uri="ws://stage.test/ws"), action)
        == result
    )
    assert calls == [("connect", "ws://stage.test/ws"), ("read", method)]


async def test_server_inspector_rejects_non_read_actions_before_connecting():
    with pytest.raises(ValueError, match="action must be one of"):
        await _inspect_server(ServerConfig(), "set-mode")


@pytest.mark.parametrize(
    "payload, message",
    [
        ({"action": "set", "arc": 12, "light": 0}, "arc index"),
        ({"action": "set", "arc": 0, "light": 14}, "light index"),
        ({"action": "set", "arc": 0, "light": 0, "color": "uv"}, "color value"),
        (
            {
                "action": "set",
                "arc": 0,
                "light": 0,
                "selector": "polarized",
                "polarization": "invalid",
            },
            "polarization",
        ),
        (
            {"action": "set", "target": "stage", "arc": 0, "light": 0},
            "target must be one of",
        ),
    ],
)
async def test_fixture_control_validates_before_connecting(payload, message):
    with pytest.raises((ValueError, IndexError), match=message):
        await _apply_fixture_control(ServerConfig(), payload)


@pytest.mark.parametrize(
    "targets, message",
    [
        ([], "non-empty array"),
        ("arc", "non-empty array"),
        (["arc"], "JSON object"),
    ],
)
async def test_fixture_control_validates_multi_target_shape(targets, message):
    with pytest.raises(TypeError, match=message):
        await _apply_fixture_control(
            ServerConfig(), {"action": "set", "targets": targets}
        )


@pytest.fixture
def running_server():
    config = ServerConfig(port=0, lightstage_uri="ws://test-stage:8080/ws")
    try:
        server = create_server(config)
    except OSError as exc:
        pytest.skip(f"Local sockets are unavailable in this environment: {exc}")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def request(server, method, path, body=None, headers=None):
    connection = http.client.HTTPConnection(
        server.server_address[0], server.server_address[1], timeout=2
    )
    connection.request(method, path, body=body, headers=headers or {})
    response = connection.getresponse()
    body = response.read()
    headers = dict(response.getheaders())
    connection.close()
    return response.status, headers, body


def test_health_and_browser_configuration_endpoints(running_server):
    status, headers, body = request(running_server, "GET", "/api/health")

    assert status == 200
    assert json.loads(body) == {"service": "lswebui", "status": "ok"}
    assert headers["Cache-Control"] == "no-store"
    assert "default-src 'self'" in headers["Content-Security-Policy"]

    status, _, body = request(running_server, "GET", "/api/config")
    config = json.loads(body)
    assert status == 200
    assert config["lightstage_uri"] == "ws://test-stage:8080/ws"
    assert config["webgpu"] == {"fallback": "canvas2d", "preferred": True}
    assert config["features"] == {"fixture_control": True}
    assert "log_requests" not in config


def test_inspection_endpoint_returns_json_serializable_server_data(
    running_server, monkeypatch
):
    from pylightstage.models import StageMode

    class FakeClient:
        def __init__(self, *, uri):
            self.uri = uri

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def get_mode(self):
            return StageMode.MANUAL

    monkeypatch.setattr("pylightstage.lswebui.server.LightStageClient", FakeClient)

    status, headers, body = request(
        running_server, "GET", "/api/inspect?action=get-mode"
    )

    assert status == 200
    assert headers["Cache-Control"] == "no-store"
    assert json.loads(body) == {"action": "get-mode", "result": "Manual"}


def test_inspection_endpoint_rejects_actions_outside_cli_submenu(running_server):
    status, _, body = request(running_server, "GET", "/api/inspect?action=set-mode")

    assert status == 400
    assert "action must be one of" in json.loads(body)["error"]


def test_connectivity_probe_reports_an_unreachable_websocket(
    running_server, monkeypatch
):
    class UnreachableClient:
        def __init__(self, *, uri):
            self.uri = uri

        async def __aenter__(self):
            raise OSError("connection refused")

        async def __aexit__(self, *_):
            return None

    monkeypatch.setattr(
        "pylightstage.lswebui.server.LightStageClient", UnreachableClient
    )

    status, _, body = request(running_server, "GET", "/api/inspect?action=get-mode")

    assert status == 502
    assert json.loads(body) == {
        "error": "Could not connect to ws://test-stage:8080/ws: connection refused"
    }


def test_fixture_endpoint_applies_a_valid_command(running_server, monkeypatch):
    commands = []

    async def apply(_config, payload):
        commands.append(payload)

    monkeypatch.setattr("pylightstage.lswebui.server._apply_fixture_control", apply)
    payload = {"action": "set", "arc": 2, "light": 5}

    status, headers, body = request(
        running_server,
        "POST",
        "/api/fixture",
        body=json.dumps(payload),
        headers={"Content-Type": "application/json"},
    )

    assert status == 200
    assert headers["Cache-Control"] == "no-store"
    assert json.loads(body) == {"status": "ok", **payload}
    assert commands == [payload]


@pytest.mark.parametrize(
    "payload, expected",
    [
        (
            {"action": "set", "target": "arc", "arc": 2},
            {"status": "ok", "action": "set", "target": "arc", "arc": 2},
        ),
        (
            {"action": "clear", "target": "horizontal_arc", "light": 5},
            {
                "status": "ok",
                "action": "clear",
                "target": "horizontal_arc",
                "light": 5,
            },
        ),
        (
            {
                "action": "set",
                "targets": [
                    {"target": "arc", "arc": 2},
                    {"target": "horizontal_arc", "light": 5},
                ],
            },
            {
                "status": "ok",
                "action": "set",
                "targets": [
                    {"target": "arc", "arc": 2},
                    {"target": "horizontal_arc", "light": 5},
                ],
            },
        ),
    ],
)
def test_fixture_endpoint_returns_group_target_metadata(
    running_server, monkeypatch, payload, expected
):
    async def apply(_config, _payload):
        return None

    monkeypatch.setattr("pylightstage.lswebui.server._apply_fixture_control", apply)

    status, _, body = request(
        running_server,
        "POST",
        "/api/fixture",
        body=json.dumps(payload),
        headers={"Content-Type": "application/json"},
    )

    assert status == 200
    assert json.loads(body) == expected


@pytest.mark.parametrize(
    "body, expected_error",
    [
        ("", "request body must contain JSON"),
        ("[]", "request body must be a JSON object"),
        ("{", "Expecting property name"),
    ],
)
def test_fixture_endpoint_rejects_invalid_json(running_server, body, expected_error):
    status, _, response_body = request(
        running_server,
        "POST",
        "/api/fixture",
        body=body,
        headers={"Content-Type": "application/json"},
    )

    assert status == 400
    assert expected_error in json.loads(response_body)["error"]


@pytest.mark.parametrize(
    "exception, expected_status, expected_error",
    [
        (TimeoutError(), 504, "Timed out connecting to ws://test-stage:8080/ws"),
        (
            RuntimeError("invalid frame"),
            502,
            "LightStage protocol error: invalid frame",
        ),
        (
            Exception("disconnected"),
            502,
            (
                "LightStage command failed at ws://test-stage:8080/ws: "
                "Exception: disconnected"
            ),
        ),
    ],
)
def test_fixture_endpoint_preserves_client_error_mapping(
    running_server, monkeypatch, exception, expected_status, expected_error
):
    async def fail(*_):
        raise exception

    monkeypatch.setattr("pylightstage.lswebui.server._apply_fixture_control", fail)

    status, _, body = request(
        running_server,
        "POST",
        "/api/fixture",
        body='{"action":"set"}',
        headers={"Content-Type": "application/json"},
    )

    assert status == expected_status
    assert json.loads(body) == {"error": expected_error}


def test_browser_connectivity_status_is_driven_by_a_repeated_read_probe(running_server):
    status, _, body = request(running_server, "GET", "/assets/app.js")

    script = body.decode()
    assert status == 200
    assert 'await readServer("get-mode")' in script
    assert (
        "window.setTimeout(checkConnectivity, CONNECTIVITY_CHECK_INTERVAL_MS)" in script
    )
    assert 'setConnectivityStatus("ready", "Ready"' in script
    assert 'setConnectivityStatus("error", "Unavailable"' in script


def test_browser_exposes_brush_and_multi_selection_controls(running_server):
    status, _, body = request(running_server, "GET", "/")
    page = body.decode()
    assert status == 200
    assert 'name="selection-brush"' in page
    assert 'value="horizontal_arc"' in page
    assert 'id="select-all-fixtures"' in page
    assert 'aria-keyshortcuts="Control+A Meta+A"' in page
    assert 'id="selection-chips"' in page

    status, _, body = request(running_server, "GET", "/assets/fixture-controls.js")
    controls = body.decode()
    assert status == 200
    assert "selectedTargets" in controls
    assert "modifiers.additive" in controls
    assert "modifiers.toggle" in controls
    assert "targets: selectedTargets.map" in controls
    assert "function selectAllFixtures()" in controls
    assert "isEditableTarget(event.target)" in controls

    status, _, body = request(running_server, "GET", "/assets/scene.js")
    assert status == 200
    assert "selectedLogicalIndices" in body.decode()


def test_2d_grid_interleaves_the_two_halves_of_each_arc(running_server):
    status, _, body = request(running_server, "GET", "/assets/renderers/canvas2d.js")

    script = body.decode()
    assert status == 200
    assert "const LIGHTS_PER_HALF_ARC = 7" in script
    assert "(light % LIGHTS_PER_HALF_ARC) * 2" in script
    assert "Math.floor(light / LIGHTS_PER_HALF_ARC)" in script


@pytest.mark.parametrize(
    "path, content_type, marker",
    [
        ("/", "text/html", b"stage-view"),
        ("/assets/api.js", "text/javascript", b"controlFixture"),
        ("/assets/app.js", "text/javascript", b"WebGPURenderer"),
        ("/assets/camera.js", "text/javascript", b"installCameraControls"),
        ("/assets/dom.js", "text/javascript", b"Required interface element"),
        (
            "/assets/fixture-controls.js",
            "text/javascript",
            b"installFixtureControls",
        ),
        ("/assets/math.js", "text/javascript", b"resizeCanvas"),
        ("/assets/scene.js", "text/javascript", b"StageScene"),
        ("/assets/renderers/canvas2d.js", "text/javascript", b"honeycomb view"),
        ("/assets/renderers/webgpu.js", "text/javascript", b"vertex_main"),
        ("/assets/renderers/labels.js", "text/javascript", b"StageLabels"),
    ],
)
def test_packaged_web_assets_are_served(running_server, path, content_type, marker):
    status, headers, body = request(running_server, "GET", path)

    assert status == 200
    assert headers["Content-Type"].startswith(content_type)
    assert marker in body


def test_every_browser_module_import_is_allow_listed(running_server):
    pending = ["/assets/app.js"]
    visited = set()

    while pending:
        path = pending.pop()
        if path in visited:
            continue
        status, _, body = request(running_server, "GET", path)
        assert status == 200, f"Module import is not served: {path}"
        visited.add(path)
        imports = re.findall(r'from\s+["\'](.+?)["\']', body.decode())
        pending.extend(urljoin(path, imported) for imported in imports)

    assert {"/assets/ibl.js", "/assets/environment-map.js"} <= visited


def test_only_allow_listed_assets_are_exposed(running_server):
    status, _, body = request(running_server, "GET", "/assets/../server.py")

    assert status == 404
    assert json.loads(body) == {"error": "Not found"}


def test_head_reports_content_length_without_body(running_server):
    get_status, get_headers, get_body = request(running_server, "GET", "/")
    head_status, head_headers, head_body = request(running_server, "HEAD", "/")

    assert get_status == head_status == 200
    assert head_body == b""
    assert head_headers["Content-Length"] == get_headers["Content-Length"]
    assert int(head_headers["Content-Length"]) == len(get_body)


@pytest.mark.parametrize("extension", ["cbor", "cbor.zst", "json"])
def test_sequence_import_decodes_and_uploads(running_server, monkeypatch, extension):
    import zstandard as zstd

    from pylightstage.models import PlaybackSequence, StageFrame

    sequence = PlaybackSequence("Test sequence", 30.0, [StageFrame()])
    uploaded = []

    async def upload(_config, value):
        uploaded.append(value)
        return value.to_summary("sequence-id")

    monkeypatch.setattr("pylightstage.lswebui.server._upload_sequence", upload)
    payload = sequence.to_cbor()
    if extension == "cbor.zst":
        payload = zstd.ZstdCompressor().compress(payload)
    elif extension == "json":
        payload = json.dumps(sequence.to_dict()).encode()
    status, _, body = request(
        running_server,
        "POST",
        f"/api/sequences/import?filename=test.{extension}",
        body=payload,
    )
    assert status == 200
    assert uploaded == [sequence]
    assert json.loads(body)["result"]["id"] == "sequence-id"


@pytest.mark.parametrize(
    "payload", [b"invalid", b"{}", b'{"name":"x","capture_hz":0,"frames":[{}]}']
)
def test_sequence_import_rejects_invalid_files(running_server, payload):
    status, _, body = request(
        running_server, "POST", "/api/sequences/import?filename=test.json", body=payload
    )
    assert status == 400
    assert "Invalid sequence file" in json.loads(body)["error"]


@pytest.mark.parametrize(
    "action, method, args",
    [
        ("play", "set_mode_playback", ("sequence-id",)),
        ("delete", "delete_sequence", ("sequence-id",)),
        ("manual", "set_mode_manual", ()),
    ],
)
async def test_sequence_commands_use_client(monkeypatch, action, method, args):
    from pylightstage.lswebui.server import _sequence_command

    calls = []

    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

    async def record(self, *values):
        calls.append(values)

    setattr(Client, method, record)
    monkeypatch.setattr("pylightstage.lswebui.server.LightStageClient", Client)
    await _sequence_command(ServerConfig(), {"action": action, "id": "sequence-id"})
    assert calls == [args]


@pytest.mark.parametrize(
    "payload",
    [{"action": "unknown"}, {"action": "play"}, {"action": "delete", "id": 1}],
)
async def test_sequence_commands_validate_before_connecting(payload):
    from pylightstage.lswebui.server import _sequence_command

    with pytest.raises(ValueError):
        await _sequence_command(ServerConfig(), payload)


def test_stage_mode_tabs_and_live_mode_are_exposed(running_server):
    status, _, body = request(running_server, "GET", "/")
    assert status == 200
    page = body.decode()
    for mode, panel in [
        ("manual", "manual-panel"),
        ("playback", "playback-panel"),
        ("olat", "capture-panel"),
    ]:
        assert f'data-workspace="{mode}"' in page
        assert f'aria-controls="{panel}"' in page
        assert f'id="{panel}"' in page
    assert 'id="sequences-dialog"' not in page
    assert 'id="stage-mode"' in page
    assert '<option value="get-mode">' not in page
    status, _, body = request(running_server, "GET", "/assets/sequences.js")
    assert status == 200
    assert 'query("#playback-panel")' in body.decode()


@pytest.mark.parametrize("mode, args", [("olat", (24.5,)), ("manual", ())])
def test_mode_endpoint_dispatches(running_server, monkeypatch, mode, args):
    calls = []

    class Client:
        def __init__(self, **kwargs):
            assert kwargs == {"uri": "ws://test-stage:8080/ws"}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def set_mode_olat(self, rate):
            calls.append((rate,))

        async def set_mode_manual(self):
            calls.append(())

    monkeypatch.setattr("pylightstage.lswebui.server.LightStageClient", Client)
    payload = {"mode": mode}
    if mode == "olat":
        payload["capture_hz"] = 24.5
    status, _, body = request(
        running_server, "POST", "/api/mode", body=json.dumps(payload)
    )
    assert status == 200
    assert json.loads(body) == {"result": None}
    assert calls == [args]


@pytest.mark.parametrize(
    "payload",
    [
        {"mode": "olat", "capture_hz": rate}
        for rate in (None, True, "30", 0, -1, float("nan"), float("inf"))
    ]
    + [{"mode": "olat"}, {"mode": "unknown"}, {"mode": "manual", "capture_hz": 30}],
)
async def test_mode_validation_precedes_connection(monkeypatch, payload):
    def unexpected_connection(**kwargs):
        pytest.fail("Invalid mode request opened a connection")

    monkeypatch.setattr(
        "pylightstage.lswebui.server.LightStageClient", unexpected_connection
    )
    with pytest.raises(ValueError):
        await _mode_command(ServerConfig(), payload)


@pytest.mark.parametrize(
    "error, expected_status",
    [
        (ValueError("invalid rate"), 400),
        (TimeoutError("timed out"), 504),
        (RuntimeError("rejected"), 502),
    ],
)
def test_mode_endpoint_errors(running_server, monkeypatch, error, expected_status):
    async def fail(*args):
        raise error

    monkeypatch.setattr("pylightstage.lswebui.server._mode_command", fail)
    status, _, body = request(
        running_server, "POST", "/api/mode", body='{"mode":"olat"}'
    )
    assert status == expected_status
    assert str(error) in json.loads(body)["error"]


def test_camera_capture_endpoint_triggers_client(running_server, monkeypatch):
    calls = []

    class Client:
        def __init__(self, *, uri):
            assert uri == "ws://test-stage:8080/ws"

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def trigger(self):
            calls.append("capture")

    monkeypatch.setattr("pylightstage.lswebui.server.LightStageClient", Client)
    status, _, body = request(running_server, "POST", "/api/capture", body="{}")
    assert status == 200
    assert json.loads(body) == {"result": None}
    assert calls == ["capture"]


@pytest.mark.parametrize(
    "error, expected_status",
    [(TimeoutError("timeout"), 504), (RuntimeError("Manual mode required"), 502)],
)
def test_camera_capture_endpoint_errors(
    running_server, monkeypatch, error, expected_status
):
    async def fail(*args):
        raise error

    monkeypatch.setattr("pylightstage.lswebui.server._trigger_camera", fail)
    status, _, body = request(running_server, "POST", "/api/capture", body="{}")
    assert status == expected_status
    assert str(error) in json.loads(body)["error"]


@pytest.mark.parametrize("port", [True, 1.5, "8000"])
def test_server_config_rejects_non_integer_ports(port):
    with pytest.raises(ValueError, match="port"):
        ServerConfig(port=port).validate()


@pytest.mark.parametrize(
    "uri",
    ["ws://", "ws:///path", "ws://host:bad", "ws://host:65536", "ws://host/#fragment"],
)
def test_server_config_rejects_malformed_websocket_uris(uri):
    with pytest.raises(ValueError):
        ServerConfig(lightstage_uri=uri).validate()


@pytest.mark.parametrize(
    "intensity", ["123", [True, 0, 0], ["1", 2, 3], {"1": 1, "2": 2, "3": 3}]
)
async def test_fixture_rejects_coercible_non_numeric_intensity(intensity, monkeypatch):
    def unexpected_connection(**_):
        pytest.fail("Invalid payload must not connect to hardware")

    monkeypatch.setattr(
        "pylightstage.lswebui.server.LightStageClient", unexpected_connection
    )
    with pytest.raises(ValueError, match="intensity"):
        await _apply_fixture_control(
            ServerConfig(),
            {
                "action": "set",
                "arc": 0,
                "light": 0,
                "intensity": intensity,
            },
        )


def test_json_rejects_non_finite_constants(running_server):
    status, headers, body = request(
        running_server, "POST", "/api/mode", body='{"mode":"olat","capture_hz":NaN}'
    )
    assert status == 400
    assert "Non-finite JSON" in json.loads(body)["error"]
    assert headers["Connection"] == "close"


@pytest.mark.parametrize(
    "headers",
    [
        {"Content-Length": "-1"},
        {"Content-Length": "32769"},
        {"Transfer-Encoding": "chunked"},
    ],
)
def test_invalid_body_framing_closes_connection(running_server, headers):
    status, response_headers, _ = request(
        running_server, "POST", "/api/capture", body="{}", headers=headers
    )
    assert status == 400
    assert response_headers["Connection"] == "close"


def test_unknown_post_route_closes_unread_body(running_server):
    status, headers, _ = request(running_server, "POST", "/unknown", body="ignored")
    assert status == 405
    assert headers["Connection"] == "close"


@pytest.mark.parametrize("value", [None, False, {}, "", [None], [[0]]])
def test_sequence_rejects_malformed_grids_before_normalization(value):
    from pylightstage.lswebui.sequence_files import decode_sequence

    data = {"name": "test", "capture_hz": 30, "frames": [{"rgb_fixtures": value}]}
    with pytest.raises(ValueError, match="Invalid sequence file"):
        decode_sequence(json.dumps(data).encode(), "test.json")


@pytest.mark.parametrize("rate", [True, "30", None, float("inf"), 0, -1])
def test_sequence_rejects_invalid_capture_rates(rate):
    from pylightstage.lswebui.sequence_files import decode_sequence

    data = {"name": "test", "capture_hz": rate, "frames": [{}]}
    with pytest.raises(ValueError, match="capture_hz"):
        decode_sequence(json.dumps(data).encode(), "test.json")


def test_sequence_reads_compressed_json_and_rejects_trailing_cbor():
    import zstandard

    from pylightstage.lswebui.sequence_files import decode_sequence
    from pylightstage.models import PlaybackSequence, StageFrame

    sequence = PlaybackSequence("test", 30, [StageFrame()])
    compressed = zstandard.ZstdCompressor().compress(
        json.dumps(sequence.to_dict()).encode()
    )
    assert decode_sequence(compressed, "TEST.JSON.ZST") == sequence
    with pytest.raises(ValueError, match="Unexpected data"):
        decode_sequence(sequence.to_cbor() + b"extra", "test.cbor")


def test_sequence_expansion_is_bounded(monkeypatch):
    import zstandard

    from pylightstage.lswebui import sequence_files

    monkeypatch.setattr(sequence_files, "MAX_SEQUENCE_BYTES", 128)
    payload = zstandard.ZstdCompressor().compress(b" " * 129)
    with pytest.raises(ValueError, match="Expanded sequence exceeds"):
        sequence_files.decode_sequence(payload, "test.zst")


def test_duplicate_content_length_is_rejected(running_server):
    connection = http.client.HTTPConnection(
        *running_server.server_address[:2], timeout=2
    )
    try:
        connection.putrequest("POST", "/api/capture")
        connection.putheader("Content-Length", "2")
        connection.putheader("Content-Length", "2")
        connection.endheaders(b"{}")
        response = connection.getresponse()
        assert response.status == 400
        assert response.getheader("Connection") == "close"
        assert "single integer Content-Length" in json.loads(response.read())["error"]
    finally:
        connection.close()


def test_slow_body_reports_request_error(running_server, monkeypatch):
    monkeypatch.setattr("pylightstage.lswebui.server._REQUEST_TIMEOUT_SECONDS", 0.01)
    status, _, body = request(
        running_server,
        "POST",
        "/api/capture",
        body="{}",
        headers={"Content-Length": "10"},
    )
    assert status == 400
    assert json.loads(body)["error"] == "Timed out reading request body"


@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_invalid_upstream_json_returns_gateway_error(
    running_server, monkeypatch, method
):
    async def inspect(*_):
        return float("nan")

    monkeypatch.setattr("pylightstage.lswebui.server._inspect_server", inspect)
    status, _, body = request(running_server, method, "/api/inspect?action=get-mode")
    assert status == 502
    if method == "HEAD":
        assert body == b""
    else:
        assert "not valid JSON" in json.loads(body)["error"]


async def test_ibl_validates_before_connecting_and_batches_rgb_and_white(monkeypatch):
    from pylightstage.lswebui.server import _apply_ibl

    calls = []

    class Client:
        def __init__(self, **kwargs):
            calls.append("connect")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            pass

        async def set_mode_manual(self):
            calls.append("manual")

        async def set_light(self, light, arc, color, intensity, go):
            calls.append((light, arc, color, intensity, go))

        async def go(self):
            calls.append("go")

    monkeypatch.setattr("pylightstage.lswebui.server.LightStageClient", Client)
    for invalid in (
        None,
        [],
        [[0, 0, 0]] * 167,
        [[0, 0, 0]] * 167 + [[True, 0, 0]],
        [[0, 0, 0]] * 167 + [[256, 0, 0]],
        [[0, 0, 0]] * 167 + [[float("nan"), 0, 0]],
    ):
        with pytest.raises((TypeError, ValueError)):
            await _apply_ibl(ServerConfig(), {"intensities": invalid})
    assert calls == []
    await _apply_ibl(ServerConfig(), {"intensities": [[10, 20, 30]] * 168})
    assert calls[:2] == ["connect", "manual"]
    assert calls[2] == (0, 0, "rgb", (10, 20, 30), False)
    assert calls[-2] == (13, 11, "w", (0, 0, 0), False)
    assert calls[-1] == "go"
    assert len(calls) == 339


def test_ibl_http_endpoint(running_server, monkeypatch):
    received = []

    async def apply(config, payload):
        received.append(payload)

    monkeypatch.setattr("pylightstage.lswebui.server._apply_ibl", apply)
    payload = {"intensities": [[12, 34, 56]] * 168}
    status, _, body = request(running_server, "POST", "/api/ibl", json.dumps(payload))
    assert status == 200
    assert json.loads(body) == {"result": None}
    assert received == [payload]
