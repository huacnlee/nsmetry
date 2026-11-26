/**
 * NsMetry, the app's entry: it mounts the root (shell/root.tsx). Kept to this so test fixtures can
 * mount the same root with screens of their own.
 */
import { mount } from "nsh";
import { Root } from "./shell/root";

mount(Root, {});
