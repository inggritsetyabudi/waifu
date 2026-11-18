import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Apply transparency before React effects, including during development reloads.
if (new URLSearchParams(window.location.search).get("mode") === "companion") {
  document.body.classList.add("companion");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
