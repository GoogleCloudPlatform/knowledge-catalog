import os
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

import gradio as gr
import pandas as pd

import metadata_propagation.ui.gradio_app as ga
from metadata_propagation.agent.plugins.context import (
    get_credentials,
    require_oauth_globally,
    reset_oauth_context,
    set_oauth_token,
)
from metadata_propagation.agent.plugins.lineage_plugin import LineagePlugin
from metadata_propagation.ui.gradio_app import (
    apply_policy_tag_recommendations,
    get_token_from_session,
    scan_dataset,
)


class TestAuthBypassADCFallback(unittest.TestCase):
    def setUp(self):
        reset_oauth_context()
        self._orig_env = os.environ.copy()
        os.environ.pop("BYPASS_OAUTH", None)
        os.environ["GOOGLE_CLIENT_ID"] = "real-google-client-id.apps.googleusercontent.com"
        os.environ["GOOGLE_CLIENT_SECRET"] = "real-google-client-secret"

    def tearDown(self):
        reset_oauth_context()
        os.environ.clear()
        os.environ.update(self._orig_env)

    @patch("google.auth.default")
    def test_get_credentials_blocks_adc_fallback_when_token_is_none(self, mock_adc):
        """Verify get_credentials raises PermissionError and never calls google.auth.default when token is None."""
        set_oauth_token(None)
        with self.assertRaises(PermissionError):
            get_credentials("test-project")
        mock_adc.assert_not_called()

    @patch("google.auth.default")
    def test_get_credentials_blocks_adc_when_token_is_empty_or_invalid_dict(self, mock_adc):
        """Verify get_credentials blocks ADC when set_oauth_token is called with an empty dict or empty string."""
        set_oauth_token({})
        with self.assertRaises(PermissionError):
            get_credentials("test-project")
        set_oauth_token("")
        with self.assertRaises(PermissionError):
            get_credentials("test-project")
        mock_adc.assert_not_called()

    @patch("google.auth.default")
    def test_get_token_from_session_rejects_empty_session(self, mock_adc):
        """Verify get_token_from_session raises gr.Error when request.session lacks google_token."""
        mock_request = MagicMock(spec=gr.Request)
        mock_request.session = {}

        with self.assertRaises(gr.Error) as ctx:
            get_token_from_session(mock_request)
        self.assertIn("Authentication required", str(ctx.exception))
        mock_adc.assert_not_called()

    @patch("google.auth.default")
    def test_get_token_from_session_rejects_expired_token_without_refresh(self, mock_adc):
        """Verify expired session tokens without refresh_token raise gr.Error instead of falling back to ADC."""
        mock_request = MagicMock(spec=gr.Request)
        mock_request.session = {
            "google_token": {
                "access_token": "expired-token",
                "expires_at": time.time() - 120,
            }
        }

        with self.assertRaises(gr.Error) as ctx:
            get_token_from_session(mock_request)
        self.assertIn("Session expired", str(ctx.exception))
        self.assertNotIn("google_token", mock_request.session)
        mock_adc.assert_not_called()

    @patch("google.auth.default")
    @patch("google.cloud.bigquery.Client")
    def test_full_taint_chain_scan_dataset_blocks_unauthenticated_caller(
        self, mock_bq_client, mock_adc
    ):
        """Reproduce the reported taint chain on scan_dataset and verify BigQuery client is never initialized with ADC."""
        unauthenticated_request = MagicMock(spec=gr.Request)
        unauthenticated_request.session = {}

        with self.assertRaises(gr.Error):
            scan_dataset(
                "test-project",
                "europe-west1",
                "test_dataset",
                request=unauthenticated_request,
            )

        mock_adc.assert_not_called()
        mock_bq_client.assert_not_called()

    @patch("google.auth.default")
    @patch("google.cloud.bigquery.Client")
    def test_lineage_plugin_blocks_adc_when_oauth_token_none(
        self, mock_bq_client, mock_adc
    ):
        """Verify LineagePlugin.scan_for_missing_descriptions raises PermissionError if set_oauth_token(None) was called."""
        set_oauth_token(None)
        plugin = LineagePlugin("test-project", "europe-west1")

        with self.assertRaises(PermissionError):
            plugin.scan_for_missing_descriptions("test_dataset")

        mock_adc.assert_not_called()
        mock_bq_client.assert_not_called()

    @patch("google.auth.default")
    def test_apply_policy_tag_recommendations_blocks_unauthenticated_caller(
        self, mock_adc
    ):
        """Verify apply_policy_tag_recommendations cannot be used by an unauthenticated attacker to escalate privileges."""
        unauthenticated_request = MagicMock(spec=gr.Request)
        unauthenticated_request.session = {}
        df = pd.DataFrame(
            {
                "Select": [True],
                "Target Column": ["ssn"],
                "Policy Tags": ["projects/p/locations/l/taxonomies/1/policyTags/2"],
            }
        )

        with self.assertRaises(gr.Error):
            apply_policy_tag_recommendations(
                "test-project",
                "europe-west1",
                "test_dataset",
                "test_table",
                df,
                "user:attacker@example.com",
                request=unauthenticated_request,
            )

        mock_adc.assert_not_called()

    @patch("google.auth.default")
    def test_get_credentials_accepts_valid_dict_and_str_tokens(self, mock_adc):
        """Verify valid user OAuth tokens (both dict and worker-thread string tokens) return user Credentials without ADC."""
        set_oauth_token({"access_token": "user-access-token-123"})
        creds = get_credentials("test-project")
        self.assertEqual(creds.token, "user-access-token-123")
        mock_adc.assert_not_called()

        # Worker thread string token propagation
        set_oauth_token("worker-thread-token-456")
        worker_creds = get_credentials("test-project")
        self.assertEqual(worker_creds.token, "worker-thread-token-456")
        mock_adc.assert_not_called()


def _unauthenticated_request():
    req = MagicMock(spec=gr.Request)
    req.session = {}
    return req


class TestProcessWideEnforcement(unittest.TestCase):
    """Defense in depth: once the server enables enforcement, no code path
    (including threads that never call set_oauth_token) may use ADC."""

    def setUp(self):
        reset_oauth_context()
        self._orig_env = os.environ.copy()
        os.environ.pop("BYPASS_OAUTH", None)
        require_oauth_globally(True)

    def tearDown(self):
        require_oauth_globally(False)
        reset_oauth_context()
        os.environ.clear()
        os.environ.update(self._orig_env)

    @patch("google.auth.default")
    def test_fresh_thread_without_token_cannot_use_adc(self, mock_adc):
        errors = []

        def worker():
            try:
                get_credentials("test-project")
            except PermissionError as e:
                errors.append(e)

        t = threading.Thread(target=worker)  # new thread: empty contextvars
        t.start()
        t.join()
        self.assertEqual(len(errors), 1)
        mock_adc.assert_not_called()

    @patch("google.auth.default")
    def test_bypass_oauth_still_allows_adc(self, mock_adc):
        mock_adc.return_value = (MagicMock(), "p")
        os.environ["BYPASS_OAUTH"] = "true"
        import metadata_propagation.agent.plugins.context as ctx

        ctx._cached_adc_creds = None
        self.assertIsNotNone(get_credentials("test-project"))
        mock_adc.assert_called_once()
        ctx._cached_adc_creds = None


class TestEveryPrivilegedHandlerRequiresSession(unittest.TestCase):
    """Every Gradio event handler with server-side effects must reject a
    request that has no OAuth session, before touching any Google client."""

    def setUp(self):
        reset_oauth_context()
        self._orig_env = os.environ.copy()
        os.environ.pop("BYPASS_OAUTH", None)

    def tearDown(self):
        reset_oauth_context()
        os.environ.clear()
        os.environ.update(self._orig_env)

    @patch("google.auth.default")
    @patch("google.cloud.bigquery.Client")
    def test_all_handlers(self, mock_bq, mock_adc):
        df = pd.DataFrame({"Select": [True]})
        calls = {
            "scan_dataset": lambda r: ga.scan_dataset("p", "l", "d", request=r),
            "analyze_and_preview": lambda r: ga.analyze_and_preview(
                "p", "l", "d", "t", request=r
            ),
            "apply_propagation_improved": lambda r: ga.apply_propagation_improved(
                "p", "l", "d", "t", df, request=r
            ),
            "get_glossary_recommendations": lambda r: ga.get_glossary_recommendations(
                "p", "l", "d", "t", request=r
            ),
            "apply_glossary_selections": lambda r: ga.apply_glossary_selections(
                "p", "l", "d", "t", df, request=r
            ),
            "get_policy_tag_recommendations": lambda r: ga.get_policy_tag_recommendations(
                "p", "l", "d", "t", request=r
            ),
            "apply_policy_tag_recommendations": lambda r: ga.apply_policy_tag_recommendations(
                "p", "l", "d", "t", df, "user:attacker@example.com", request=r
            ),
            "get_dq_propagation": lambda r: ga.get_dq_propagation(
                "p", "l", "d", "t", request=r
            ),
            "handle_doc_uploads": lambda r: ga.handle_doc_uploads(
                ["/tmp/x.pdf"], [], [], "rag", request=r
            ),
            "handle_refresh_lineage_cache": lambda r: ga.handle_refresh_lineage_cache(
                request=r
            ),
        }
        for name, call in calls.items():
            with self.subTest(handler=name):
                with self.assertRaises(gr.Error):
                    call(_unauthenticated_request())
                with self.assertRaises(gr.Error):
                    call(None)  # no request object at all
        mock_adc.assert_not_called()
        mock_bq.assert_not_called()


class TestAuthStatusAndServer(unittest.TestCase):
    def setUp(self):
        reset_oauth_context()
        self._orig_env = os.environ.copy()
        os.environ.pop("BYPASS_OAUTH", None)
        os.environ["GOOGLE_CLIENT_ID"] = "cid.apps.googleusercontent.com"
        os.environ["GOOGLE_CLIENT_SECRET"] = "csecret"
        os.environ["SESSION_SECRET_KEY"] = "test-secret"

    def tearDown(self):
        require_oauth_globally(False)
        reset_oauth_context()
        os.environ.clear()
        os.environ.update(self._orig_env)

    def _check_auth_status(self):
        for fn in ga.demo.fns.values():
            if getattr(fn, "name", "") == "check_auth_status":
                return fn.fn
        self.fail("check_auth_status not registered on demo.load")

    def test_missing_oauth_config_no_longer_implies_adc_mode(self):
        os.environ["GOOGLE_CLIENT_ID"] = ""
        login, app = self._check_auth_status()(_unauthenticated_request())
        self.assertTrue(login["visible"])
        self.assertFalse(app["visible"])

    def test_check_auth_status_shows_app_only_for_session_or_bypass(self):
        check = self._check_auth_status()
        login, app = check(_unauthenticated_request())
        self.assertFalse(app["visible"])

        authed = MagicMock(spec=gr.Request)
        authed.session = {"google_token": {"access_token": "tok"}}
        login, app = check(authed)
        self.assertTrue(app["visible"])

        os.environ["BYPASS_OAUTH"] = "true"
        login, app = check(_unauthenticated_request())
        self.assertTrue(app["visible"])

    def test_server_refuses_to_start_without_oauth_or_explicit_bypass(self):
        os.environ["GOOGLE_CLIENT_ID"] = ""
        with self.assertRaises(RuntimeError):
            ga.create_app()
        os.environ["BYPASS_OAUTH"] = "true"
        ga.create_app()  # explicit ADC mode is allowed

    def test_server_enables_process_wide_enforcement(self):
        import metadata_propagation.agent.plugins.context as ctx

        ga.create_app()
        self.assertTrue(ctx._oauth_required_globally)

    def test_api_and_upload_endpoints_require_session_but_login_page_works(self):
        from fastapi.testclient import TestClient

        client = TestClient(ga.create_app())
        # Attacker: programmatic API call / upload without a session cookie.
        r = client.post(
            "/gradio_api/call/scan_dataset",
            json={"data": ["p", "l", "d", None, None]},
        )
        self.assertEqual(r.status_code, 401)
        r = client.post("/gradio_api/upload", files={"files": ("a.txt", b"x")})
        self.assertEqual(r.status_code, 401)
        # Login page must stay usable for unauthenticated visitors: the page,
        # its config, and the queue used by the Login button / demo.load.
        self.assertEqual(client.get("/").status_code, 200)
        self.assertEqual(client.get("/config").status_code, 200)
        r = client.post(
            "/gradio_api/queue/join",
            json={"data": [], "fn_index": 0, "session_hash": "abc"},
        )
        self.assertNotEqual(r.status_code, 401)


class TestQueuedRequestTokenPropagation(unittest.TestCase):
    """Real gr.Request objects (not mocks) as produced by Gradio's queue."""

    def setUp(self):
        reset_oauth_context()
        self._orig_env = os.environ.copy()
        os.environ.pop("BYPASS_OAUTH", None)

    def tearDown(self):
        reset_oauth_context()
        os.environ.clear()
        os.environ.update(self._orig_env)

    def _request(self, state=None, session=None):
        from starlette.requests import Request as StarletteRequest

        scope = {
            "type": "http", "method": "POST", "path": "/gradio_api/queue/join",
            "headers": [], "query_string": b"", "state": dict(state or {}),
        }
        if session is not None:
            scope["session"] = session
        return gr.Request(StarletteRequest(scope))

    def test_live_request_session_is_gradio_obj_not_dict(self):
        # Root cause of logged-in users never getting their own token on main:
        # gr.Request returns the session token as gradio Obj, not dict.
        req = self._request(session={"google_token": {"access_token": "user-tok"}})
        self.assertNotIsInstance(req.session.get("google_token"), dict)
        self.assertEqual(get_token_from_session(req)["access_token"], "user-tok")

    def test_live_request_state_token(self):
        req = self._request(state={"google_token": {"access_token": "user-tok"}})
        self.assertEqual(get_token_from_session(req)["access_token"], "user-tok")

    def test_pickled_request_uses_preserved_state(self):
        import pickle

        req = pickle.loads(pickle.dumps(self._request(
            state={"google_token": {"access_token": "user-tok"}},
            session={"google_token": {"access_token": "user-tok"}},
        )))
        with self.assertRaises(AttributeError):
            req.session  # session does not survive pickling
        self.assertEqual(get_token_from_session(req)["access_token"], "user-tok")

    @patch("google.auth.default")
    def test_requests_without_token_are_rejected(self, mock_adc):
        import pickle

        for req in (
            self._request(state={"google_token": None}, session={}),
            pickle.loads(pickle.dumps(self._request(state={"google_token": None}))),
        ):
            with self.assertRaises(gr.Error):
                get_token_from_session(req)
        mock_adc.assert_not_called()


if __name__ == "__main__":
    unittest.main()
