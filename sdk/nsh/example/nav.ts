// The navigation stack's state, created once; pages import it to navigate.
import { createNavStack } from "nsh/base";

export type Route = { name: "home" } | { name: "settings" };

export const nav = createNavStack<Route>([{ name: "home" }]);
