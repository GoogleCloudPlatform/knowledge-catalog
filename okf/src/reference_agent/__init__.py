__version__ = "0.1.0"

# Default Gemini model used by the agents and the index synthesizer.
# Defined here (a dependency-free leaf module) so it has a single source of
# truth without creating an import cycle between agent.py and bundle.index.
DEFAULT_MODEL = "gemini-flash-latest"
