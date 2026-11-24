// Multiline-string recovery reparses after each repair. Bound cumulative UTF-16
// source characters parsed so a many-literal snippet cannot cause quadratic work
// to stall the backend indefinitely. Unrepaired code still fails syntax validation.
export const MAX_MULTILINE_STRING_PARSE_CHARACTERS = 1024 * 1024;
