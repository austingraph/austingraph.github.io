# austingraph — Video Demo Script

_Three real Travis County parcels, three different users, one app. Follow along on screen at **austingraph.github.io**. Every address and number below is live in the app today._

**The 10-second pitch:** austingraph is an interactive map of all 374,000 Travis County parcels. Click any lot and instantly see its zoning, what it could become under Austin's new rules, appraisal and tax data, flood and watershed flags, live city permits, and a one-click development feasibility report. Work that normally takes hours of digging through TCAD, the city GIS, and permit portals — collapsed into one click.

How to drive the app on camera:
- **Search** — top of screen, "Search address…" — type an address (3+ letters), pick from the dropdown.
- **Or click** any parcel on the map. The left **panel** opens with everything known about that lot; a development **envelope** (red setbacks, green buildable area) draws on the map.

---

## Scenario 1 — The HOME Ordinance: turning one house into three
### 📍 3015 E 51st St, Austin 78723 · Zoned SF-3-NP

**Who this is for:** an **infill developer** or a **homeowner-builder** asking, *"Austin changed the rules — how many homes can I actually put on this single-family lot, and does the math work?"*

This is the headline use case. Austin's **HOME ordinance** (Home Options for Middle-income Empowerment) now lets up to **3 units** go on what used to be a one-house lot. austingraph reads that rule for you.

**Step by step (narrate as you click):**

1. **Search "3015 E 51st"** and select it. The map flies in; the lot highlights gold and a development envelope draws over it.
2. **Property** section — a **1960** house, ~0.78 acre. *"An older single-family home, the classic candidate."*
3. **Planning context** — Current zoning **SF-3**, Future land use **Mixed Residential**. A highlighted note flags it: *"Future land use intends higher intensity than current zoning — potential upzoning / redevelopment candidate."* The app spotted the opportunity automatically.
4. **Appraisal & Tax** — Market value **$514,528**, with land and improvement values and an estimated annual tax. *"Here's what the county says it's worth today."*
5. **Development potential** — this is the HOME moment. Point to:
   - **Max units (HOME): 3** — *"The ordinance lets me build three homes here instead of one."*
   - **Buildable footprint**, **Setbacks** (F 25 / SS 15 / S 5 / R 10 ft), **Max height 35 ft**, **Impervious cap 45%** — all computed live from the zoning code, not looked up by hand.
   - On the map, the **green buildable area** vs **red setbacks** shows exactly where a building can go.
6. **Site Check** — green flags: not in a FEMA floodplain, **Urban watershed**, **Austin Full-Purpose jurisdiction** (city permits apply). *"No flood or watershed surprises — this one's clean to develop."*
7. **Connections** — live City of Austin permit history for the lot, pulled in real time.

### 💰 The financial walkthrough — Feasibility Report

Click **Feasibility Report** (top of the panel). A full report opens with a mini-map, the appraisal breakdown, and an interactive **Development feasibility** model.

8. Point to the **Scenario** buttons: **By-right · Max density · Hold as-is · Residual land**. Choose **By-right** — *"Tear down, rebuild what the zoning allows."*
9. Read the honest framing aloud — the report says it plainly: *"Proof of concept. These figures use generic cost, rent, and interest-rate assumptions… every tinted input is editable."*
10. Walk the ledger top to bottom — it reads like a clean spreadsheet:
    - **Site** — Lot area, Buildable floor area, Max units (3).
    - **Uses (costs)** — Land/acquisition (seeded from the county land value, ~$178k here), Hard cost $/SF, Soft costs %, Contingency 5%, Construction financing → **Total project cost**.
    - **Exit / income** — toggle **For-sale** and set a sale $/SF, or **Rental** for rent / cap-rate.
    - **Returns** — **Estimated profit**, **Return on cost**, **Return on equity**.
11. **The magic moment — make it interactive.** Every tinted cell is editable. Change **Buildable floor area** to a realistic three-townhome build (~5,400 SF) and set **For-sale price** to a market ~$350/SF. The result banner **recomputes live** and flips green — an estimated profit on the order of **~$200K at roughly a 13% return on cost** _(illustrative — your screen shows the live figure)_.
12. Try **Residual land** — the banner rephrases to *"You could pay up to $X for the land to earn a 15% return on cost,"* and compares it to the county's land value. *"This answers the only question a land buyer really has: what can I pay?"*

> **Takeaway:** *"In ninety seconds I went from a 1960 bungalow to a three-unit pro forma — zoning, costs, and returns — without leaving the map."*

---

## Scenario 2 — Commercial site selection: a 3.4-acre vacant lot
### 📍 307 E Huntland Dr, Austin 78752 · Zoned CS-MU-V-NP

**Who this is for:** a **commercial broker** or **multifamily developer** scouting redevelopment sites near the old Highland Mall / ACC Highland district, asking *"How much can this site hold, and is it shovel-ready?"*

**Step by step:**

1. **Search "307 E Huntland"** and select it. A large parcel highlights.
2. **Property** — **3.4 acres**, and notice **no building value** in Appraisal. *"This is vacant commercial land — a blank slate."*
3. **Appraisal & Tax** — Market value **$2,205,870**, essentially all land. *"You're buying dirt, priced like dirt."*
4. **Planning context** — Current zoning **CS** (commercial services), Future land use **Mixed Use**. *"Zoned commercial today, the city's plan wants mixed-use — exactly the corridor story."*
5. **Development potential** — the capacity headline tells the whole story:
   - **Max floor area (FAR 2.0): ~280,000 SF** of buildable floor area.
   - **Max height 60 ft**, **Impervious cap 95%**, minimal setbacks (it's commercial).
   - *"Nearly 280,000 square feet of entitlement on one assemblage-ready lot."*
6. **Site Check** — confirm jurisdiction is **Austin Full-Purpose** (city handles permitting) and check the watershed/flood flags before anyone spends a dollar on due diligence.
7. **Connections** — live permit activity in the area.
8. **Look it up** — one-click out to the **TCAD record**, **City permits (AB+C)**, the city's **Property Profile** (zoning · flood · historic), **Aerial**, and **Street View** — every authoritative source a broker would otherwise open in six separate tabs.

> **Takeaway:** *"A broker can pre-qualify a site's size, zoning, and entitlement before ever calling the listing agent."*

---

## Scenario 3 — Due diligence on a constrained lot: flood + Barton Springs + ETJ
### 📍 6107 Turtle Point Dr, Austin 78746 · Lost Creek

**Who this is for:** an **architect** or **urban planner** doing site due diligence, asking *"What's going to bite me on this property before I take the project?"*

This parcel is the **Site Check** showcase — it lights up with constraints that would each take a separate agency lookup to discover.

**Step by step:**

1. **Search "6107 Turtle Point"** and select it. A wooded Lost Creek lot near the river.
2. **Appraisal & Tax** — a **$1.05M** property, 1979 home. *"High-value West Austin — exactly where mistakes are expensive."*
3. **Planning context** — note it reads **"Outside City of Austin zoning."** *"First flag: this isn't in the city's zoning — that changes who permits it."*
4. **Site Check** — the heart of this scenario. Three flags fire:
   - 🔴 **Floodplain** — *"In FEMA floodplain — 1% annual chance (SFHA), zone A."* Building here triggers floodplain review.
   - 🔴 **Watershed — Barton Springs Zone** — *"Strict water-quality limits."* The most heavily regulated watershed in Austin.
   - 🔵 **Jurisdiction — 2-mile ETJ** — *"Extraterritorial jurisdiction — county permits, no city zoning."*
   - *"Three deal-shaping constraints — flood, Barton Springs, and ETJ — surfaced in one glance. Each of those is normally a separate trip to a different agency's map."*
5. **Development potential** shows limited data here — *and that's the point:* because it's in the ETJ with no city zoning, there's no city entitlement to compute. The app tells you honestly rather than guessing.
6. **Look it up** — jump straight to the city's **Property Profile** and **FEMA** sources to verify the flood line before drawing a single plan.

> **Takeaway:** *"An architect knows in thirty seconds that this site means floodplain engineering, Barton Springs water-quality controls, and county permitting — before writing a proposal."*

---

## Closing line for the video
*"Three completely different properties — an infill teardown, a commercial assemblage, and a constrained luxury lot — and the same one click answered the first hour of questions for each. That's austingraph."*

---

### Who each scenario sells to
| Scenario | Parcel type | Primary user | The hook |
|---|---|---|---|
| 1 — HOME infill | SF-3 single-family | Infill developer, homeowner-builder | "3 units + a profit number in 90 seconds" |
| 2 — Commercial | Vacant CS land | Commercial broker, MF developer | "280,000 SF of entitlement, pre-qualified" |
| 3 — Constraints | Flood / BSZ / ETJ | Architect, urban planner | "Every deal-killer, surfaced in one glance" |

_Figures in the feasibility walkthrough are screening estimates from generic assumptions and are fully editable; all parcel, appraisal, zoning, and Site Check data is live from the app._
