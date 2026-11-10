// Checks tool input against the subset of JSON Schema the tool definitions use.

function is(type, value) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'integer':
      return Number.isInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return false
  }
}

function check(schema, value, path, errors) {
  const types = schema.type ? [schema.type].flat() : null
  if (types && !types.some((type) => is(type, value))) {
    errors.push(`${path} must be ${types.join(' or ')}`)
    return
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`)
    return
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) errors.push(`${path} is too short`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is longer than ${schema.maxLength}`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be at least ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be at most ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} takes at most ${schema.maxItems} items`)
    if (schema.items) value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors))
  }
  if (is('object', value) && schema.properties) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push(`${path}.${key} is required`)
    }
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties[key]
      if (!property) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key} is not a known field`)
        continue
      }
      check(property, item, `${path}.${key}`, errors)
    }
  }
}

export function validate(schema, value) {
  const errors = []
  check(schema, value, 'input', errors)
  return errors
}

export function withDefaults(schema, value) {
  const out = { ...value }
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (out[key] === undefined && property.default !== undefined) out[key] = property.default
  }
  return out
}
