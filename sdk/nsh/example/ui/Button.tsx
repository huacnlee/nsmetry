// The example's one styled control: a primary button drawn from theme tokens.
import { Text } from "nsh";
import { Button as BaseButton } from "nsh/base";

export function Button(props: { label: string; onPress: () => void }) {
  return (
    <BaseButton
      onPress={props.onPress}
      class="rounded-(--radius) bg-primary px-4 py-2 transition-colors duration-150 hover:bg-primary/90 active:bg-primary/80"
    >
      <Text class="text-sm font-medium text-primary-foreground">{props.label}</Text>
    </BaseButton>
  );
}
