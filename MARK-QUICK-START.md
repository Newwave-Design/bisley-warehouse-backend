# Mark's Warehouse WMS Quick Reference

**Your new warehouse management system — for barcode scanning, stock receipt, and order picking.**

---

## ✨ What Your WMS Does

1. **Scan barcodes** from your USB scanner
2. **Receive stock** into the warehouse with bin assignment
3. **Track inventory** in real-time
4. **Pick customer orders** by scanning products
5. **Log everything** for compliance

---

## 🏪 Step-by-Step: Receiving Stock

### When a box arrives from the supplier:

1. **Open WMS app** on your warehouse computer/tablet
2. **Click "Receive Stock"**
3. **Scan the barcode** (or type it)
   - Supercode format: `H2910NL-BLK` (SKU + colour)
   - Example: A box label showing `H2910NL-BLK`
4. **Confirm the product:**
   - App shows: *"Bisley 4-Leg Desk, Black"*
   - If correct, tap ✓
5. **Select bin location:**
   - Choose where to store it (e.g., **A1**, **B2**)
   - If unsure, ask manager
6. **Enter quantity:**
   - How many units in the box? (e.g., **10**)
7. **Add notes (optional):**
   - E.g., "Damaged corner on 2 units"
8. **Tap "Receive"** — ✅ Done!

**What happens behind the scenes:**
- Warehouse inventory updated instantly
- Your action logged (who, when, what, where)
- Total stock at that bin increases

---

## 🔍 Finding Stock Quickly

### I need to know where a SKU is stored:

1. **Click "Search Inventory"**
2. **Type the SKU** (e.g., `H2910NL`)
3. **App shows all locations:**
   - *"A1: 10 units (Black)"*
   - *"A3: 5 units (Red)"*
   - *"B2: 8 units (White)"*
4. **Go to the bin**

### I want to see what's in a specific bin:

1. **Click "View Bin"**
2. **Select bin location** (e.g., **A1**)
3. **App lists everything in that bin:**
   - *"10x H2910NL-BLK"*
   - *"5x H2920NL-BLK"*
   - *"3x E4D4L-GRN"*

---

## 📦 Step-by-Step: Picking an Order

### When a customer order comes in (from web shop):

1. **Click "Active Pick Lists"**
2. **See pending orders** with number of items each
   - *"PL-20260818-0001: 3 items"*
   - *"PL-20260818-0002: 2 items"*
3. **Tap the order** you want to pick
4. **App shows what to pick:**
   - *"Item 1/3: Pick 1x H2910NL-BLK from A1"*
5. **Go to bin A1**
6. **Scan the product** (or type SKU+colour)
   - App beeps ✓ if correct
   - App error if wrong SKU
7. **Confirm quantity** picked (e.g., 1 unit)
8. **Tap "Picked"** — ✓
9. **Next item:** *"Item 2/3: Pick 2x H2910NL-RED from B3"*
10. **Repeat steps 5-8** for each item
11. **All items picked?** Tap **"Complete Order"**
12. **Order ready for packing!** ✅

**Progress shown:** *"2 of 3 items picked"* as you go

---

## ⚠️ What If There's a Problem?

### Product not found when scanning?

- Check the barcode is correct
- Try typing the SKU manually
- Ask manager to add it to the system
- Don't guess — get confirmation!

### Not enough stock in the bin?

- App will say: *"Only 3 units in A1, but 5 required"*
- Check other bins where SKU is stored
- Pick from multiple bins if needed
- Note the shortage (manager will order more)

### Damaged units in a box?

- Log it in notes when receiving
- Example: *"Damaged corner on unit 3, substituted with undamaged"*
- Manager can track patterns

### Wrong product in the bin?

- **Don't put it there!**
- Scan it to confirm what it is
- Report to manager
- They'll tell you where it should go

---

## 🎯 Barcode Format Reference

### Supercode (SKU + Colour)

Format: `SKU-COLOURCODE`

Examples:
- `H2910NL-BLK` = Bisley 4-Leg Desk, Black
- `H2910NL-RED` = Bisley 4-Leg Desk, Red
- `E4D4L-GRN` = Some product, Green
- `A3D2-CRM` = Some product, Cream

**Colours you'll see:**
- BLK = Black
- WHT = White
- RED = Red
- BLU = Blue
- GRN = Green
- GRY = Grey
- OLV = Olive
- CRM = Cream
- YEL = Yellow
- etc.

### Plain SKU (If Colour Not Encoded)

Format: `SKU`

Example: `H2910NL`

**App will ask:** *"Which colour? (Black / Red / White)"*

---

## 📊 Your Daily Flow

### Morning

1. Check **Active Pick Lists** — how many orders today?
2. Start picking if orders exist
3. Log any damaged stock from overnight

### Midday

1. Receive supplier stock as it arrives
2. Scan, assign bins, confirm quantities
3. Note any issues

### End of Day

1. Complete any remaining pick lists
2. Review today's movements (audit log)
3. Notify manager of shortages

---

## 🔒 Your Login

You'll log in with:
- **Email:** mark@bisley.com
- **Password:** (set during onboarding)

App will give you a **token** valid for 24 hours. If you log out, log back in.

---

## ❓ Common Questions

**Q: What if I scan the wrong product?**  
A: App will show the wrong product name. Tap "No" or scan the correct one. Waste not!

**Q: Can I pick multiple bins for one order?**  
A: Yes! If `H2910NL-BLK` is in A1 and A3, pick from both. App tracks it.

**Q: What if a box says it has 10 units but only 9 inside?**  
A: Log it! In the "Notes" field, write: "Received 9 instead of 10." Manager will follow up with supplier.

**Q: Do I need to use the barcode scanner or can I type?**  
A: Use the **scanner** when possible (faster, fewer mistakes). Typing is OK as backup.

**Q: What if I pick the wrong quantity?**  
A: App shows "X of Y units picked." If wrong, just update the number before confirming.

**Q: Can I undo a pick?**  
A: Tell your manager. They can reset it in the admin panel.

**Q: What if the system goes down?**  
A: Note what you picked/received on paper. Update the system when it's back.

---

## 🆘 Need Help?

- **Bug or error?** Report to manager with details
- **Unclear about a pick?** Ask manager before picking
- **Suggestion for the app?** Tell your manager

---

## ✅ Checklist Before You Start

- ✓ USB barcode scanner connected
- ✓ Computer/tablet has internet access
- ✓ You have your login email & password
- ✓ WMS app is open: http://localhost:3001 (or Railway URL)
- ✓ Health check shows 🟢 (app is running)

---

## 🚀 You're Ready!

Go pick some orders! Your efficiency matters.

Remember: **Scan, confirm, move on.** No guessing!

---

*Last updated: 2026-08-18*  
*Questions? Ask your manager or see the full README for technical details.*
