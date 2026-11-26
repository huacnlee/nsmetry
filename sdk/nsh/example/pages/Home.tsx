// The first page: one custom event and a way to another screen.
import { NavPage } from "nsh/base";
import { Text, View } from "nsh";
import { nsmetry } from "../analytics";
import { nav } from "../nav";
import { Button } from "../ui/Button";
import { Header } from "../ui/Header";

export function Home() {
  return (
    <NavPage title="Home" header={<Header title="Home" />}>
      <View class="flex-1 gap-3 bg-background p-4">
        <Text class="text-sm text-muted-foreground">Events are batched and sent every 30 seconds, or when the app goes to the background.</Text>
        <Button label="Export" onPress={() => nsmetry.track("export", { format: "csv" })} />
        <Button label="Open settings" onPress={() => nav.push({ name: "settings" })} />
      </View>
    </NavPage>
  );
}
