// @ts-check

/**
 * returns an object
 * prevents double-encoding for recursion when serializing nested structures
 * @param {any} object
 * @returns {object}
 */
function serializeHelper(object) {
  // typeof null === 'object', so check first
  if (object === null) {
    return {type: 'null', value: null};
  }

  if (object === undefined) {
    return {type: 'undefined', value: null};
  }

  // number including NaN and infinity
  if (typeof object === 'number') {
    if (Number.isNaN(object)) {
      return {type: 'number', value: 'NaN'};
    }
    if (object === Infinity) {
      return {type: 'number', value: 'Infinity'};
    }
    if (object === -Infinity) {
      return {type: 'number', value: '-Infinity'};
    }
    return {type: 'number', value: object};
  }

  if (typeof object === 'string') {
    return {type: 'string', value: object};
  }

  if (typeof object === 'boolean') {
    return {type: 'boolean', value: object};
  }

  // BigInt TODO: check if needed, 0 pts
  if (typeof object === 'bigint') {
    return {type: 'bigint', value: object.toString()};
  }

  // Function
  if (typeof object === 'function') {
    return {type: 'function', value: object.toString()};
  }

  // data typeof object, so if we checked for obj first, would be treated as a reg dictionary
  // ie stripped of special formatting etc
  if (object instanceof Date) {
    return {type: 'date', value: object.toISOString()};
  }

  // same here error instanceof object
  if (object instanceof Error) {
    return {
      type: 'error',
      value: {
        message: object.message,
        name: object.name,
        stack: object.stack,
      },
    };
  }

  // remember eg iframe - then it will be within. So typeof wouldnt pass
  if (Array.isArray(object)) {
    // Recursively serialize each element
    const serializedElements = object.map((elem) => serializeHelper(elem));
    return {type: 'array', value: serializedElements};
  }

  if (typeof object === 'object') {
    const serializedObj = {};
    for (const key of Object.keys(object)) {
      serializedObj[key] = serializeHelper(object[key]);
    }
    return {type: 'object', value: serializedObj};
  }

  // Fallback TODO: check
  return {type: 'unknown', value: String(object)};
}

/**
 * @param {any} object
 * @returns {string}
 */
function serialize(object) {
  return JSON.stringify(serializeHelper(object));
}


/**
 * Similar as above, works with pasred objects and not stings
 * @param {object} parsed
 * @returns {any}
 */
function deserializeHelper(parsed) {
  switch (parsed.type) {
    case 'null':
      return null;

    case 'undefined':
      return undefined;

    case 'number':
      if (parsed.value === 'NaN') {
        return NaN;
      }
      if (parsed.value === 'Infinity') {
        return Infinity;
      }
      if (parsed.value === '-Infinity') {
        return -Infinity;
      }
      return parsed.value;

    case 'string':
      return parsed.value;

    case 'boolean':
      return parsed.value;

    case 'bigint':
      return BigInt(parsed.value);

    case 'function': {
      // eval - execute code from a string
      // whats within eval must be a valid JS expression
      // i.e., evaluate to a single value, not a statement/block of code
      // i.e., force an expression to be evaluated
      // we wrap the function string in parentheses to make it a valid expression
      const fn = eval('(' + parsed.value + ')');
      return fn;
    }

    case 'date':
      return new Date(parsed.value);

    case 'error': {
      const err = new Error(parsed.value.message);
      err.name = parsed.value.name;
      err.stack = parsed.value.stack;
      return err;
    }

    case 'array':
      // Recursively deserialize each element
      return parsed.value.map((elem) => deserializeHelper(elem));

    case 'object': {
      // Recursively deserialize each property
      const result = {};
      for (const key of Object.keys(parsed.value)) {
        result[key] = deserializeHelper(parsed.value[key]);
      }
      return result;
    }

    default:
      throw new Error(`Unknown serialized type: ${parsed.type}`);
  }
}

/**
 * @param {string} string
 * @returns {any}
 */
function deserialize(string) {
  if (typeof string !== 'string') {
    throw new Error(`Invalid argument type: ${typeof string}.`);
  }

  const parsed = JSON.parse(string);
  return deserializeHelper(parsed);
}

module.exports = {
  serialize,
  deserialize,
};
