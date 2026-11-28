/**
 * Minimal JSON-schema-lite validator (no deps).
 * Supports: type, required, enum, minimum, maximum, minLength, maxLength, pattern, additionalProperties, properties, items.
 */
export function validateSchema(schema, value, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return { ok: true, errors: [] };

  const types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : null);
  if (types) {
    const t = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const okType = types.some((want) => {
      if (want === 'integer') return typeof value === 'number' && Number.isInteger(value);
      if (want === 'number') return typeof value === 'number' && !Number.isNaN(value);
      if (want === 'object') return t === 'object' && value !== null && !Array.isArray(value);
      return t === want;
    });
    if (!okType) errors.push(`${path}: expected ${types.join('|')}, got ${t}`);
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: value not in enum`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: < minimum`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: > maximum`);
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: shorter than minLength`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: longer than maxLength`);
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern mismatch`);
      } catch { /* ignore bad pattern */ }
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    const required = schema.required || [];
    for (const key of required) {
      if (value[key] === undefined) errors.push(`${path}.${key}: required`);
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      if (value[key] !== undefined) {
        const r = validateSchema(child, value[key], `${path}.${key}`);
        errors.push(...r.errors);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
          errors.push(`${path}.${key}: additional property not allowed`);
        }
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      const r = validateSchema(schema.items, item, `${path}[${i}]`);
      errors.push(...r.errors);
    });
  }
  return { ok: errors.length === 0, errors };
}
