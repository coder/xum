import { z } from "zod";

/**
 * Documented values of the OpenAI Responses API `access_programs.cyber` field
 * (https://developers.openai.com/api/docs/guides/daybreak, retrieved
 * 2026-09-30). The API rejects null and unknown values, so requests either
 * omit the field or send one of these.
 */
export const OpenAICyberAccessProgramSchema = z.enum(["standard", "daybreak_blue", "daybreak_red"]);
export type OpenAICyberAccessProgram = z.infer<typeof OpenAICyberAccessProgramSchema>;
