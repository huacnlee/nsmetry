// A second screen, so navigation has something to record.
import { NavPage } from "nsh/base";
import { Text, View } from "nsh";
import { Header } from "../ui/Header";

export function Settings() {
  return (
    <NavPage title="Settings" header={<Header title="Settings" />}>
      <View class="flex-1 bg-background p-4">
        <Text class="text-sm text-foreground">Nothing to set.</Text>
      </View>
    </NavPage>
  );
}
