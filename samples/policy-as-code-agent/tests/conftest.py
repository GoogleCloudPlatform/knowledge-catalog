import pathlib

import dotenv
import pytest


def pytest_configure(config: pytest.Config) -> None:
    del config  # unused

    # Load environment variables for tests
    dotEnvFilename = pathlib.Path(__file__).parent.parent / ".env"
    _ = dotenv.load_dotenv(dotEnvFilename)
