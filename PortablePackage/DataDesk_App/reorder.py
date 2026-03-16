import codecs
import re

file_path = 'index.html'
with codecs.open(file_path, 'r', 'utf-8') as f:
    text = f.read()

def extract_block(t, start_marker):
    idx = t.find(start_marker)
    if idx == -1:
        print("Could not find", start_marker)
        return "", t
    
    div_start = t.find('<div', idx)
    count = 0
    end_idx = div_start
    while end_idx < len(t):
        if t.startswith('<div', end_idx):
            count += 1
            end_idx += 4
        elif t.startswith('</div', end_idx):
            count -= 1
            end_idx += 5
            if count == 0:
                end_idx = t.find('>', end_idx) + 1
                block = t[idx:end_idx]
                
                # remove from text
                new_t = t[:idx] + t[end_idx:]
                return block, new_t
        else:
            end_idx += 1
    return "", t

print("Extracting blocks...")
# Extract individual inner cards
net, text = extract_block(text, '<!-- NETWORK INFRASTRUCTURE (Simplified & Redesigned) -->')
periph, text = extract_block(text, '<!-- PERIPHERALS & TOPOGRAPHY -->')
browser, text = extract_block(text, '<!-- BROWSER MEMORY MONITOR (EXPANDED) -->')
m365, text = extract_block(text, '<!-- M365 DESKTOP INFRASTRUCTURE -->')

# Extract the entire row 5
forensics, text = extract_block(text, '<!-- ROW 5: UNIFIED FORENSIC INTELLIGENCE -->')

# Now remove the empty row wrappers for row 2 and row 3b
# Row 2 wrapper
r2_start = text.find('<!-- ROW 2: NETWORK & PERIPHERALS CLUSTER (2-Card Wide) -->')
r2_end_div = text.find('</div>', r2_start) + 6
text = text[:r2_start] + text[r2_end_div:]

# Row 3b wrapper
r3b_start = text.find('<!-- ROW 3b: EXPANDED BROWSER & M365 (2-Card Layout) -->')
r3b_end_div = text.find('</div>', r3b_start) + 6
text = text[:r3b_start] + text[r3b_end_div:]

# Now reconstruct the layout
# Find where ROW 1 ends.
r1_start = text.find('<!-- ROW 1: PRIMARY COMPUTE STACK (4-Card Wide Expansion) -->')
# Find the end of ROW 1
count = 0
end_idx = text.find('<div', r1_start)
while end_idx < len(text):
    if text.startswith('<div', end_idx):
        count += 1
        end_idx += 4
    elif text.startswith('</div', end_idx):
        count -= 1
        end_idx += 5
        if count == 0:
            end_idx = text.find('>', end_idx) + 1
            break
    else:
        end_idx += 1

r1_end = end_idx

# Build new pieces
new_row_2 = f"""

                    <!-- NEW ROW 2 (Promoted): UNIFIED FORENSIC INTELLIGENCE -->
                    {forensics}
"""

new_row_3 = f"""

                    <!-- NEW ROW 3 (Swapped): NETWORK & BROWSER CLUSTER (2-Card Wide) -->
                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:25px; margin-bottom:25px;">
                        {net}
                        {browser}
                    </div>
"""

new_row_4b = f"""

                    <!-- NEW ROW 4b: EXPANDED PERIPHERALS & M365 (2-Card Layout) -->
                    <div id="telemetry-addon-row-b" style="display:grid; grid-template-columns: 1.5fr 1fr; gap:20px; margin-bottom:25px;">
                        {periph}
                        {m365}
                    </div>
"""

# Insert new rows.
# insert after row 1: new_row_2, new_row_3, then row 3a is already there (now called row 4a), then insert new_row_4b after it.

text = text[:r1_end] + new_row_2 + new_row_3 + text[r1_end:]

# find row 3a (which is now ROW 4a logically)
r3a_start = text.find('<!-- ROW 3a: SUPPORTING TELEMETRY (3-Card Layout) -->')
count = 0
end_idx = text.find('<div', r3a_start)
while end_idx < len(text):
    if text.startswith('<div', end_idx):
        count += 1
        end_idx += 4
    elif text.startswith('</div', end_idx):
        count -= 1
        end_idx += 5
        if count == 0:
            end_idx = text.find('>', end_idx) + 1
            break
    else:
        end_idx += 1

r3a_end = end_idx

text = text[:r3a_end] + new_row_4b + text[r3a_end:]

with codecs.open('index.html', 'w', 'utf-8') as f:
    f.write(text)

print("Layout restructuring complete.")
