import importlib.util
import json
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("accept-elicitation.py")
SPEC = importlib.util.spec_from_file_location("accept_elicitation", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

PROMPT = (
    b'Server requests input:\r\n"Test client default value handling - please accept with defaults"'
    b"\r\nSchema:\r\n"
    + json.dumps(MODULE.EXPECTED_SCHEMA, indent=2).replace("\n", "\r\n").encode()
    + b"\r\nChoose accept, decline, or cancel: "
)


class ValidateFormPromptTest(unittest.TestCase):
    def test_accepts_exact_upstream_prompt_and_schema(self):
        MODULE.validate_form_prompt(PROMPT)

    def test_rejects_added_schema_field(self):
        schema = MODULE.EXPECTED_SCHEMA.copy()
        schema["properties"] = {**schema["properties"], "unexpected": {"type": "string"}}
        prompt = PROMPT.replace(
            json.dumps(MODULE.EXPECTED_SCHEMA, indent=2).replace("\n", "\r\n").encode(),
            json.dumps(schema, indent=2).replace("\n", "\r\n").encode(),
        )
        with self.assertRaisesRegex(RuntimeError, "refusing acceptance"):
            MODULE.validate_form_prompt(prompt)

    def test_rejects_changed_field_type(self):
        schema = json.loads(json.dumps(MODULE.EXPECTED_SCHEMA))
        schema["properties"]["age"]["type"] = "string"
        prompt = PROMPT.replace(
            json.dumps(MODULE.EXPECTED_SCHEMA, indent=2).replace("\n", "\r\n").encode(),
            json.dumps(schema, indent=2).replace("\n", "\r\n").encode(),
        )
        with self.assertRaisesRegex(RuntimeError, "refusing acceptance"):
            MODULE.validate_form_prompt(prompt)

    def test_rejects_integer_instead_of_boolean_default(self):
        schema = json.loads(json.dumps(MODULE.EXPECTED_SCHEMA))
        schema["properties"]["verified"]["default"] = 1
        prompt = PROMPT.replace(
            json.dumps(MODULE.EXPECTED_SCHEMA, indent=2).replace("\n", "\r\n").encode(),
            json.dumps(schema, indent=2).replace("\n", "\r\n").encode(),
        )
        with self.assertRaisesRegex(RuntimeError, "refusing acceptance"):
            MODULE.validate_form_prompt(prompt)


if __name__ == "__main__":
    unittest.main()
