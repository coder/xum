import { getToolComponent } from "./getToolComponent";
import { ProposePlanToolCall } from "../ProposePlanToolCall";
import { publishToolCards } from "./toolCardsStore";

// The lazy chunk of the tool cards (see toolCardsStore). Evaluating it publishes them.
publishToolCards({ getToolComponent, ProposePlanToolCall });

export default function ToolCardsLoader() {
  return null;
}
