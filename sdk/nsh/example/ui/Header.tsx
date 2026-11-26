// The page header on the desktops and the web; iOS and Android draw the system's from the page's title.
import { Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { nav } from "../nav";

export function Header(props: { title: string }) {
  return (
    <View class="flex-row items-center gap-3 border-b border-border px-4 py-3">
      <If when={nav.routes().length > 1}>
        <BaseButton onPress={() => nav.pop()} class="active:opacity-60">
          <Text class="text-sm text-primary">Back</Text>
        </BaseButton>
      </If>
      <Text class="text-base font-semibold text-foreground">{props.title}</Text>
    </View>
  );
}
