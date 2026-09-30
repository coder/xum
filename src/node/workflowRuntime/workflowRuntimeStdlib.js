function __muxSchemaWithOptions(schema, options) {
  if (options && typeof options === "object" && !Array.isArray(options)) {
    return Object.assign(schema, options);
  }
  return schema;
}
function __muxSchemaString(options) {
  return __muxSchemaWithOptions({ type: "string" }, options);
}
function __muxSchemaNumber(options) {
  return __muxSchemaWithOptions({ type: "number" }, options);
}
function __muxSchemaInteger(options) {
  return __muxSchemaWithOptions({ type: "integer" }, options);
}
function __muxSchemaBoolean(options) {
  return __muxSchemaWithOptions({ type: "boolean" }, options);
}
function __muxSchemaArray(items, options) {
  return __muxSchemaWithOptions({ type: "array", items: items }, options);
}
function __muxSchemaEnum(values, options) {
  return __muxSchemaWithOptions({ type: "string", enum: __muxUtilsAsArray(values) }, options);
}
function __muxSchemaOptional(schema) {
  var clone = Object.assign({}, schema || {});
  Object.defineProperty(clone, "__muxOptional", { value: true });
  return clone;
}
function __muxSchemaIsOptional(schema) {
  return Boolean(schema && schema.__muxOptional === true);
}
function __muxSchemaStripOptional(schema) {
  return __muxSchemaIsOptional(schema) ? Object.assign({}, schema) : schema;
}
function __muxSchemaNullable(schema) {
  var clone = Object.assign({}, schema || {});
  var type = clone.type;
  if (typeof type === "string") clone.type = type === "null" ? ["null"] : [type, "null"];
  else if (Array.isArray(type))
    clone.type = type.indexOf("null") === -1 ? type.concat(["null"]) : type;
  else clone.type = ["null"];
  if (Array.isArray(clone.enum) && clone.enum.indexOf(null) === -1) {
    clone.enum = clone.enum.concat([null]);
  }
  return clone;
}
function __muxSchemaUnion(schemas) {
  var types = [];
  var sourceSchemas = Array.isArray(schemas) ? schemas : [];
  for (var index = 0; index < sourceSchemas.length; index += 1) {
    var type = sourceSchemas[index] && sourceSchemas[index].type;
    var schemaTypes = Array.isArray(type) ? type : [type];
    for (var typeIndex = 0; typeIndex < schemaTypes.length; typeIndex += 1) {
      var schemaType = schemaTypes[typeIndex];
      if (typeof schemaType === "string" && types.indexOf(schemaType) === -1)
        types.push(schemaType);
    }
  }
  return { type: types };
}
function __muxSchemaObject(properties, options) {
  var sourceProperties = properties || {};
  var keys = Object.keys(sourceProperties);
  var cleanProperties = {};
  var inferredRequired = [];
  for (var index = 0; index < keys.length; index += 1) {
    var key = keys[index];
    var propertySchema = sourceProperties[key];
    cleanProperties[key] = __muxSchemaStripOptional(propertySchema);
    if (!__muxSchemaIsOptional(propertySchema)) inferredRequired.push(key);
  }
  var required = inferredRequired;
  if (options && Array.isArray(options.required)) {
    required = options.required.filter(function (key) {
      return keys.includes(key);
    });
  } else if (options && options.required === false) {
    required = [];
  }
  var schema = { type: "object", required: required, properties: cleanProperties };
  if (options && Object.prototype.hasOwnProperty.call(options, "additionalProperties")) {
    schema.additionalProperties = options.additionalProperties;
  }
  return schema;
}
function __muxUtilsAsArray(value) {
  return Array.isArray(value) ? value : [];
}
function __muxUtilsOptionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
function __muxUtilsBoundedInt(value, fallback, min, max) {
  var number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(number)) return fallback;
  var lower = Number.isInteger(min) ? min : number;
  var upper = Number.isInteger(max) ? max : number;
  return Math.max(lower, Math.min(number, upper));
}
function __muxUtilsStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(function (item) {
      return typeof item === "string" && item.trim().length > 0;
    })
    .map(function (item) {
      return item.trim();
    });
}
function __muxUtilsFencedJson(value) {
  return "\x60\x60\x60json\n" + JSON.stringify(value, null, 2) + "\n\x60\x60\x60";
}
function __muxUtilsCompactText(value, limit) {
  if (typeof value !== "string") return value;
  if (!Number.isInteger(limit) || limit < 0 || value.length <= limit) return value;
  return (
    value.slice(0, limit) + "\n[truncated by mux.utils.compactText after " + limit + " characters]"
  );
}
function __muxUtilsMustObject(value, message) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message || "Expected object");
  }
  return value;
}
globalThis.mux = Object.freeze({
  schema: Object.freeze({
    string: __muxSchemaString,
    number: __muxSchemaNumber,
    integer: __muxSchemaInteger,
    boolean: __muxSchemaBoolean,
    array: __muxSchemaArray,
    object: __muxSchemaObject,
    enum: __muxSchemaEnum,
    union: __muxSchemaUnion,
    optional: __muxSchemaOptional,
    nullable: __muxSchemaNullable,
  }),
  utils: Object.freeze({
    asArray: __muxUtilsAsArray,
    optionalString: __muxUtilsOptionalString,
    boundedInt: __muxUtilsBoundedInt,
    stringList: __muxUtilsStringList,
    fencedJson: __muxUtilsFencedJson,
    compactText: __muxUtilsCompactText,
    mustObject: __muxUtilsMustObject,
  }),
});
