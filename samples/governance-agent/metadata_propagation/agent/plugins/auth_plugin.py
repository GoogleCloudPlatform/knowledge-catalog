from google.adk.agents.invocation_context import InvocationContext
from google.adk.plugins.base_plugin import BasePlugin
from google.genai.types import Content

from .context import set_oauth_token


class AuthPlugin(BasePlugin):
    """
    Plugin to capture OAuth token from session state and set it in ContextVars.
    Expects 'oauth_token' to be present in the session state.
    """

    def __init__(self):
        super().__init__(name="auth_plugin")

    async def before_run_callback(
        self, *, invocation_context: InvocationContext
    ) -> Content | None:
        # Extract token from session state
        # The user/frontend is expected to pass oauth_token via state_delta or have it in session.state
        session = invocation_context.session
        token = session.state.get("oauth_token")

        if token:
            set_oauth_token(token)
        else:
            # CRITICAL: Explicitly clear the token from context if it's missing in session state.
            # This prevents thread reuse from leaking previous user's credentials.
            set_oauth_token(None)

        return None
