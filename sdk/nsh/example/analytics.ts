// The app's one analytics client, created once at module load. Pages import
// `nsmetry` to track; the shell wires lifecycle flushing and screen views.
import { createNsMetry } from "nsmetry";

export const nsmetry = createNsMetry({
  // Your instance and the site as registered in its dashboard.
  endpoint: "https://stats.example.com",
  site: "nsmetry-example",
  // An anonymous install id kept in NSH Storage: active users and retention.
  persistUserId: true,
  // appVersion comes from nsh.json ("1.4.0") unless given here.
});
