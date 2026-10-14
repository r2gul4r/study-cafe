export function reviewChoices<T extends { id: string }>(
  choices: T[],
  order?: string[],
) {
  if (
    !order ||
    order.length !== choices.length ||
    new Set(order).size !== choices.length
  )
    return choices;
  const byId = new Map(choices.map((choice) => [choice.id, choice]));
  if (order.some((id) => !byId.has(id))) return choices;
  return order.map((id) => byId.get(id)!);
}
