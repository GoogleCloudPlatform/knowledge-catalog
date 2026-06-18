# Copyright 2024 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Utility functions for the ConversationLearner agent."""

import os


def get_consumer_project() -> str:
  """Extracts the consumer project from the environment variable.

  Returns:
      The consumer project ID.

  Raises:
      ValueError: If the GOOGLE_CLOUD_PROJECT environment variable is not set.
  """
  consumer_project = os.environ.get("GOOGLE_CLOUD_PROJECT")

  if not consumer_project:
    raise ValueError("GOOGLE_CLOUD_PROJECT environment variable is required.")

  return consumer_project
