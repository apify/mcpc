/**
 * Dialect-aware JSON Schema validator for tool output validation.
 *
 * Protocol 2026-07-28 (SEP-2106) standardizes tool schemas on JSON Schema 2020-12, and the
 * SDK's default validator hard-fails any schema stamped with an older `$schema` dialect.
 * Most existing 2025-era servers, however, generate their `outputSchema` with
 * zod-to-json-schema, which stamps `"$schema": "http://json-schema.org/draft-07/schema#"` —
 * with the default validator every `tools/call` against such a tool fails before the request
 * is even sent (e.g. @modelcontextprotocol/server-filesystem's `read_file`).
 *
 * This provider routes schemas declaring a legacy dialect to a draft-07 AJV engine (the
 * SDK v1 behavior, using the engine the SDK re-exports for exactly this purpose) and
 * everything else to the SDK's default 2020-12 engine. Engines are constructed lazily.
 */

import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from '@modelcontextprotocol/client';
import {
  Ajv,
  AjvJsonSchemaValidator,
  addFormats,
} from '@modelcontextprotocol/client/validators/ajv';

/**
 * `$schema` URIs of pre-2020-12 dialects routed to the tolerant draft-07 engine.
 * Includes draft 2019-09: the SDK's default engine rejects its dialect URI outright,
 * while the draft-07 engine (strict mode off, schema self-validation off) compiles it
 * and simply ignores the few 2019-09-only keywords — validating is strictly better
 * than failing every call to such a tool.
 */
const LEGACY_DIALECT_PATTERN =
  /^https?:\/\/json-schema\.org\/(draft-0[467]|draft\/2019-09)\/schema#?$/;

export class DialectAwareJsonSchemaValidator implements jsonSchemaValidator {
  /** SDK default engine (JSON Schema 2020-12), constructed lazily by the SDK itself. */
  private modernValidator = new AjvJsonSchemaValidator();
  /** Draft-07 engine for legacy-stamped schemas, constructed on first use. */
  private legacyValidator: AjvJsonSchemaValidator | undefined;

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const dialect = (schema as { $schema?: unknown }).$schema;
    if (typeof dialect === 'string' && LEGACY_DIALECT_PATTERN.test(dialect)) {
      if (!this.legacyValidator) {
        // The documented v1-equivalent construction: validateSchema off so a stamped
        // `$schema` never fails engine-side, formats registered to keep `format` checks.
        const ajv = new Ajv({
          strict: false,
          validateFormats: true,
          validateSchema: false,
          allErrors: true,
        });
        addFormats(ajv);
        this.legacyValidator = new AjvJsonSchemaValidator(ajv);
      }
      return this.legacyValidator.getValidator<T>(schema);
    }
    return this.modernValidator.getValidator<T>(schema);
  }
}
