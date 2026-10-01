import { readServer } from "./api.js";
import { errorMessage, query, setStatus } from "./dom.js";

export function installInspector() {
  const form = query("#server-inspector");
  const result = query("#inspect-result");
  const button = query("button", form);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    result.hidden = false;
    setStatus(result, "Reading…", "working");
    try {
      setStatus(result, JSON.stringify(await readServer(form.elements.action.value), null, 2), "success");
    } catch (error) {
      setStatus(result, errorMessage(error), "error");
    } finally {
      button.disabled = false;
    }
  });
}
