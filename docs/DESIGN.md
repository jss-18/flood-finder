# Flood Finder: community edition

## Purpose
Help residents share factual storm-related incidents, help people understand reported conditions, and help authorized coordinators organize a response. The core loop is Report → Review → Respond. This revision preserves that idea and the original roles and database model.

This design was implemented and visually inspected in the browser. Figma authoring remains pending because the current chat does not expose Figma tools and the browser requires sign-in. Do not describe this document as a completed Figma file.

## Visual direction
- Background: cool off-white `#f6f8fb`.
- Text: navy `#20374e`; secondary text `#607489`.
- Primary action: blue `#285f9e`, with white text.
- Warm coral for illustrative hazards; severity labels keep both words and color.
- White cards with thin borders, 16–20 px corners, and restrained shadows.
- System sans-serif typography. Large, short headings; plain descriptions; prominent report and map actions.
- Decorative home illustration is explicitly labeled Illustration. Actual report counts come from the database.

## Screen plan for Figma
Create Desktop / Overview, Desktop / Incident map, Mobile / Overview, Mobile / Incident map, and Report dialog frames.

Overview: white navigation, two-column introduction with two actions and a labeled community illustration, actual community counts, three workflow cards, and a final map link. On narrow screens the introduction and illustration stack.

Incident map: heading and update status, refresh/report actions, report list beside the map, and official NWS alerts below. Filters cover type, status, priority, sort order, and signed-in ownership. On narrow screens the map precedes the report list. The map's Fit reports action frames the current results.

Report dialog: category and urgency, factual title and description, optional landmark, location pin or coordinate entry, and a publication action. Signing in from the report action resumes the report dialog. Reports remain unverified until reviewed.

Command center: review queue, actual metrics, teams, and user roles. Incident details expose review and assignment controls to administrators.

My assignments: the team lead advances one step at a time through Acknowledged → En route → On scene → Completed. Rejected incidents cancel active work. Reopening an incident with its former team creates a fresh assignment.

## Interaction and accessibility
- Clear empty states distinguish no submissions from no matching results.
- Keyboard focus, a skip link, current-page navigation, and menu expansion state are included.
- Motion is disabled when the device requests reduced motion.
- Smaller screens use stacked forms and at least 16 px input text.
- Report refresh failures display a visible stale-information notice. Disconnected live updates show Reconnecting.
- Official alerts and community reports remain separate sources. Routes are estimated, not flood-safe guarantees.

## Validation
Automated tests cover authentication and roles, report creation, dispatch and progress, cancellation/reopening, availability, ownership/priority filtering, and bursts of live-update events. Browser checks cover the home view, incident map, map tiles, official alert loading, and navigation at the available viewport sizes.

## Remaining design work
Save the above frames in Figma after account access is available. Validate on a physical phone and with representative residents and coordinators. Challenge submission eligibility, attribution, and rules have not been assessed as part of this code revision.
