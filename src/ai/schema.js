/**
 * Tiny JSON shape checks for AI answers (Release A).
 */
export class SchemaMismatch extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SchemaMismatch';
    this.code = 'SCHEMA_MISMATCH';
    this.details = details;
  }
}

export function assertShape(value, shape, label = 'response') {
  if (shape.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new SchemaMismatch(`${label} must be an object`, { label });
    }
    for (const key of shape.required || []) {
      if (value[key] === undefined || value[key] === null) {
        throw new SchemaMismatch(`${label} missing required field: ${key}`, { label, key });
      }
    }
    if (shape.props) {
      for (const [k, sub] of Object.entries(shape.props)) {
        if (value[k] !== undefined && value[k] !== null) assertShape(value[k], sub, `${label}.${k}`);
      }
    }
    return value;
  }
  if (shape.type === 'array') {
    if (!Array.isArray(value)) throw new SchemaMismatch(`${label} must be an array`, { label });
    if (shape.minLength != null && value.length < shape.minLength) {
      throw new SchemaMismatch(`${label} needs at least ${shape.minLength} item(s)`, { label });
    }
    if (shape.items) value.forEach((item, i) => assertShape(item, shape.items, `${label}[${i}]`));
    return value;
  }
  if (shape.type === 'string' && typeof value !== 'string') {
    throw new SchemaMismatch(`${label} must be a string`, { label });
  }
  return value;
}

export const SHAPES = {
  analysis: { type: 'object', required: ['summary'], props: { summary: { type: 'string' } } },
  plan: { type: 'object', required: ['steps'], props: { steps: { type: 'array', minLength: 0 } } },
  codeFiles: {
    type: 'object',
    required: ['files'],
    props: {
      files: {
        type: 'array',
        items: { type: 'object', required: ['path', 'content'], props: { path: { type: 'string' }, content: { type: 'string' } } },
      },
    },
  },
  patch: {
    type: 'object',
    required: ['files'],
    props: {
      files: {
        type: 'array',
        items: { type: 'object', required: ['path'], props: { path: { type: 'string' } } },
      },
    },
  },
};
