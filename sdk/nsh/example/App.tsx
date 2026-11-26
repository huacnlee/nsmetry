// The shell: the navigation stack, and the two lines that wire analytics to it.
import { mount, View } from "nsh";
import { NavStack } from "nsh/base";
import { Window } from "nsh/desktop";
import { navStackPath, useNsMetry, useScreenTracking } from "nsmetry";
import { nsmetry } from "./analytics";
import { nav } from "./nav";
import { Home } from "./pages/Home";
import { Settings } from "./pages/Settings";

function App() {
  // Flush when the app goes to the background.
  useNsMetry(nsmetry);
  // One screen view per page shown: "/home", "/settings".
  useScreenTracking(nsmetry, navStackPath(nav, (route) => `/${route.name}`));

  return (
    <View class="flex-1 bg-background">
      <NavStack state={nav} class="flex-1">
        {(route) => {
          switch (route.name) {
            case "home":
              return <Home />;
            case "settings":
              return <Settings />;
          }
        }}
      </NavStack>
    </View>
  );
}

mount(() => <Window id="main">{App}</Window>);
