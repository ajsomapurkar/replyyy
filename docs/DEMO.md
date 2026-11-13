# Five-minute demo script

Run `npm run reset && npm run dev`. Open **Console** http://localhost:5173 (Kavya Menon), **Rider** http://localhost:5174 (Priya Nair) and **Driver** http://localhost:5175 (Arjun Rao). For step 5 open the driver app in a private window as **Meera Iyer**. Tip: phone-sized browser windows (or real phones on the same Wi-Fi) for rider and driver.

1. **Control Tower** — KPI strip, live fleet (circles = available, diamonds = offer pending, arrows = on trip, dashed "!" = stale GPS). Toggle **Demand-gap overlay**: Tech Park usually shows the gap.
2. **Passenger** — Clocktower Square → Orbit Towers is pre-filled. Show the Solo quote + fare breakdown. Click **Relay Share**: cheaper shared option and *Why other shared rides weren't offered* (capacity / detour). Request **Solo**.
3. **Ops** — click the new ride: Decision card explains why Arjun was chosen (fastest ETA, idle-time bonus) vs runner-up Meera, with score components and skipped drivers (stale GPS, offline, not approved…).
4. **Driver (Arjun)** — offer card with countdown → **Decline**. Passenger shows "Finding another driver… we moved on automatically"; Ops timeline shows `DRIVER_REJECTED → RETRYING_NEXT_CANDIDATE`. (Or let it time out after 20 s.)
5. **Driver (Meera)** — **Accept** → *I've arrived* → *Start trip* → *Complete*. Passenger updates live; ride lands in History with fare detail.
6. **Zones** — pick the gap zone: predicted vs actual chart with range, MAE/WAPE, expected gap, advisory reposition suggestions (reason, distance, horizon, predicted effect), simulated multiplier with exact fare impact.
7. **Pooling** — back in Passenger, Relay Share shows the compatible ride and the two rejected ones. If the scenario cars have finished, **⚙ Demo controls → Re-create shared-ride scenario**.
8. **Analytics** — KPIs/charts and the **strategy evaluation** table (nearest vs ETA vs ETA+fairness). It's a simulation, not field evidence.

Extras: ⚙ **Freeze GPS of a busy simulated driver** → after 90 s the ride enters `EXCEPTION` (Exceptions tab), resolves itself when GPS returns or via Reassign/Resolve.
Note: simulated passengers are never offered to the two human demo drivers (visible as `RESERVED_FOR_DEMO`), so background traffic won't hijack the scripted flow.
