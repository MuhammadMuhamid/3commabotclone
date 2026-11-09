// MUST stay the first import: it strips the ticket from the URL before
// anything else runs (OD-4).
import { ticketFromFragment } from "./fragment";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import EnrollApp from "./EnrollApp";
import "../index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EnrollApp ticket={ticketFromFragment} />
  </StrictMode>
);
