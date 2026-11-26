/**
 * The ui gallery on its own, without a server: `nsh run app/gallery.tsx` (any target) shows every
 * control in light and dark (the switch at the top). Development only: the app's entry is App.tsx,
 * and signed-in development builds also reach the gallery from the account menu.
 */
import { mount, Scroll, setColorScheme, View } from "nsh";
import { ToastHost } from "./ui";
import { Gallery } from "./ui/gallery";

function GalleryApp() {
  return (
    <View class="flex-1 bg-background">
      <Scroll testID="gallery-scroll" class="flex-1" contentClass="items-center">
        <View class="w-full px-6 py-6" style={{ maxWidth: 1100 }}>
          <Gallery onAppearance={(a) => setColorScheme(a)} />
        </View>
      </Scroll>
      <ToastHost />
    </View>
  );
}

mount(GalleryApp, {});
