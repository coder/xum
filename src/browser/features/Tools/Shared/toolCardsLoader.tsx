import { getToolComponent } from "./getToolComponent";
import { ProposePlanToolCall } from "../ProposePlanToolCall";
import { AskUserQuestionChain } from "../AskUserQuestion/AskUserQuestionChain";
import { publishToolCards } from "./toolCardsStore";

// The lazy chunk of the tool cards (see toolCardsStore). Evaluating it publishes them.
publishToolCards({ getToolComponent, ProposePlanToolCall, AskUserQuestionChain });

export default function ToolCardsLoader() {
  return null;
}
