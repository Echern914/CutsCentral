import { describe, expect, it } from "vitest";
import {
  IMPORT_FIELD_LIMITS,
  countVCards,
  looksLikeVCard,
  parseDelimited,
  parseVCards,
  parseWeeklyHours,
  rowsFromTable,
  type HoursWindow,
} from "./clientImportParse.js";

/* Every name, phone and email here is invented; phones are 555 numbers. */

describe("parseDelimited", () => {
  it("reads a plain comma file", () => {
    expect(parseDelimited("First name,Phone\nTheo,302-555-0101\n")).toEqual([
      ["First name", "Phone"],
      ["Theo", "302-555-0101"],
    ]);
  });

  it("strips a UTF-8 byte-order mark so the first header still matches", () => {
    const table = parseDelimited("﻿First name,Last name\nTheo,Lark");
    expect(table[0]![0]).toBe("First name");
  });

  it("sniffs a semicolon file (a European Excel export)", () => {
    expect(parseDelimited("Name;Phone;Notes\nTheo Lark;302-555-0101;likes a 2 guard, no beard\n")).toEqual([
      ["Name", "Phone", "Notes"],
      ["Theo Lark", "302-555-0101", "likes a 2 guard, no beard"],
    ]);
  });

  it("sniffs a tab file", () => {
    expect(parseDelimited("Name\tEmail\nTheo Lark\ttheo@example.com")).toEqual([
      ["Name", "Email"],
      ["Theo Lark", "theo@example.com"],
    ]);
  });

  it("obeys Excel's sep= hint line and drops it", () => {
    expect(parseDelimited("sep=;\r\nName;Phone\r\nTheo, Jr;302-555-0101")).toEqual([
      ["Name", "Phone"],
      ["Theo, Jr", "302-555-0101"],
    ]);
  });

  it("reads quoted fields, doubled quotes and line breaks inside quotes", () => {
    const csv = 'Name,Notes\n"Lark, Theo","said ""see you soon""\nsecond line"\n';
    expect(parseDelimited(csv)).toEqual([
      ["Name", "Notes"],
      ["Lark, Theo", 'said "see you soon"\nsecond line'],
    ]);
  });

  it("keeps a quote in the middle of an unquoted cell as text", () => {
    expect(parseDelimited('Name\nMarcus "Moe" Reed\n')[1]).toEqual(['Marcus "Moe" Reed']);
  });

  it("accepts CRLF, CR and LF line endings and drops blank rows", () => {
    expect(parseDelimited("Name\r\nTheo\r\n\r\nRowan\rIvy\n,\n")).toEqual([["Name"], ["Theo"], ["Rowan"], ["Ivy"]]);
  });

  it("takes the delimiter from the header row, not from the data", () => {
    // An unquoted note full of semicolons in a comma file (Excel only quotes
    // a cell holding the file's own delimiter).
    expect(parseDelimited("Name,Notes\nTheo Lark,2 guard; no beard; cash; Fridays\n")[1]).toEqual([
      "Theo Lark",
      "2 guard; no beard; cash; Fridays",
    ]);
    // A title line above a semicolon header.
    expect(parseDelimited("Customers, exported 10/15\nName;Phone\nTheo Lark;302-555-0101\n")[2]).toEqual([
      "Theo Lark",
      "302-555-0101",
    ]);
  });

  it("does not let a comma in a quoted header outvote the real delimiter", () => {
    expect(parseDelimited('"Name, full";Phone\nTheo Lark;302-555-0101')[1]).toEqual(["Theo Lark", "302-555-0101"]);
  });

  it("returns nothing for empty input", () => {
    expect(parseDelimited("")).toEqual([]);
    expect(parseDelimited("﻿")).toEqual([]);
  });
});

describe("rowsFromTable", () => {
  it("maps the classic headers, as the importer always has", () => {
    const { rows, missingName } = rowsFromTable(
      parseDelimited("First name,Last name,Phone,Email,Notes\nTheo,Lark,302-555-0101,theo@example.com,regular\n"),
    );
    expect(missingName).toBe(false);
    expect(rows).toEqual([
      { row: 1, firstName: "Theo", lastName: "Lark", phone: "302-555-0101", email: "theo@example.com", notes: "regular" },
    ]);
  });

  it("reads Booksy-style headers: Customer name, Mobile phone, E-mail", () => {
    const { rows } = rowsFromTable(
      parseDelimited("Customer name;Mobile phone;E-mail;Note\nRowan Pike Jr;302-555-0102;rowan@example.com;fade\n"),
    );
    expect(rows).toEqual([
      { row: 1, firstName: "Rowan", lastName: "Pike Jr", phone: "302-555-0102", email: "rowan@example.com", notes: "fade" },
    ]);
  });

  it.each([
    ["Client", "Phone Number", "Email address"],
    ["Full Name", "Mobile", "Email"],
    ["Name", "Cell phone", "Email Address"],
    ["Client name", "Telephone", "Mail"],
  ])("matches %s / %s / %s", (nameHeader, phoneHeader, emailHeader) => {
    const { rows } = rowsFromTable([
      [nameHeader, phoneHeader, emailHeader],
      ["Ivy Stone", "302-555-0103", "ivy@example.com"],
    ]);
    expect(rows[0]).toMatchObject({ firstName: "Ivy", lastName: "Stone", phone: "302-555-0103", email: "ivy@example.com" });
  });

  it("prefers First/Last columns over a Name column", () => {
    const { rows } = rowsFromTable([
      ["Name", "First name", "Last name"],
      ["Ignored Name", "Theo", "Lark"],
    ]);
    expect(rows[0]).toMatchObject({ firstName: "Theo", lastName: "Lark" });
  });

  it("finds the header below a title line, and numbers rows from it", () => {
    const { rows, missingName } = rowsFromTable(
      parseDelimited("Customers - exported 10/15/2026\nName,Phone\nTheo Lark,302-555-0101\nRowan Pike,302-555-0102\n"),
    );
    expect(missingName).toBe(false);
    expect(rows.map((r) => [r.row, r.firstName, r.phone])).toEqual([
      [1, "Theo", "302-555-0101"],
      [2, "Rowan", "302-555-0102"],
    ]);
  });

  it("says when there is no name column at all", () => {
    expect(rowsFromTable([["Phone", "Email"], ["302-555-0101", "a@example.com"]])).toEqual({
      rows: [],
      missingName: true,
    });
  });

  it("leaves out a row with no name but keeps numbering by position in the file", () => {
    const { rows } = rowsFromTable([["First name", "Phone"], ["Theo", "1"], ["", "2"], ["Rowan", "3"]]);
    expect(rows.map((r) => [r.row, r.firstName])).toEqual([
      [1, "Theo"],
      [3, "Rowan"],
    ]);
  });

  it("clips every field to the import route's caps and drops empty ones", () => {
    const L = IMPORT_FIELD_LIMITS;
    const { rows } = rowsFromTable([
      ["First name", "Last name", "Phone", "Email", "Notes"],
      ["T".repeat(90), "L".repeat(90), "9".repeat(60), `${"a".repeat(170)}@x.com`, "n".repeat(2100)],
      ["Rowan", "", "", "", ""],
    ]);
    const [a, b] = rows;
    expect(a!.firstName.length).toBe(L.firstName);
    expect(a!.lastName!.length).toBe(L.lastName);
    expect(a!.phone!.length).toBe(L.phone);
    expect(a!.email!.length).toBe(L.email);
    expect(a!.notes!.length).toBe(L.notes);
    expect(b).toEqual({ row: 2, firstName: "Rowan", lastName: undefined, phone: undefined, email: undefined, notes: undefined });
  });

  it("returns nothing for an empty table", () => {
    expect(rowsFromTable([])).toEqual({ rows: [], missingName: false });
  });
});

describe("parseVCards", () => {
  const iphone = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "PRODID:-//Apple Inc.//iPhone OS 17.0//EN",
    "N:Lark;Theo;;;",
    "FN:Theo Lark",
    "TEL;type=HOME;type=VOICE:(302) 555-0110",
    "item1.TEL;type=CELL;type=VOICE;type=pref:(302) 555-0101",
    "item1.X-ABLabel:mobile",
    "EMAIL;type=INTERNET;type=HOME;type=pref:theo@example.com",
    "NOTE:Likes a skin fade\\, no beard\\nPays cash",
    "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6AB",
    " AAMAAAABAAEAAKACAAQAAAABAAACWKADAAQAAAABAAACWAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklN",
    " BAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgCWAJYAwEiAAIRAQMRAf/EAB8A",
    "END:VCARD",
    "BEGIN:VCARD",
    "VERSION:3.0",
    "N:Pike;Rowan;;;",
    "FN:Rowan Pike",
    "EMAIL;type=INTERNET:rowan@example.com",
    "END:VCARD",
  ].join("\r\n");

  it("reads an iPhone export: N for the name, the mobile number, the note", () => {
    expect(parseVCards(iphone)).toEqual([
      {
        row: 1,
        firstName: "Theo",
        lastName: "Lark",
        phone: "(302) 555-0101",
        email: "theo@example.com",
        notes: "Likes a skin fade, no beard\nPays cash",
      },
      { row: 2, firstName: "Rowan", lastName: "Pike", phone: undefined, email: "rowan@example.com", notes: undefined },
    ]);
  });

  it("unfolds folded lines (CRLF + space or tab)", () => {
    const vcf = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Theo\r\n  Lark\r\nTEL:302-555-01\r\n\t01\r\nEND:VCARD\r\n";
    expect(parseVCards(vcf)).toEqual([
      { row: 1, firstName: "Theo", lastName: "Lark", phone: "302-555-0101", email: undefined, notes: undefined },
    ]);
  });

  it("decodes vCard 2.1 quoted-printable UTF-8, soft line breaks included (Android)", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:2.1",
      "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;Jos=C3=A9;;;",
      "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jos=C3=A9 M=C3=BCller",
      "TEL;CELL:302-555-0104",
      "NOTE;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:First line=0D=0ASecond =",
      "line with an emoji =F0=9F=92=88",
      "END:VCARD",
    ].join("\n");
    expect(parseVCards(vcf)).toEqual([
      {
        row: 1,
        firstName: "José",
        lastName: "Müller",
        phone: "302-555-0104",
        email: undefined,
        notes: "First line\r\nSecond line with an emoji \u{1F488}",
      },
    ]);
  });

  it("reads vCard 2.1 bare parameters and prefers the cell number", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:2.1",
      "N:Stone;Ivy;;;",
      "TEL;HOME:302-555-0110",
      "TEL;WORK;FAX:302-555-0111",
      "TEL;CELL:302-555-0103",
      "END:VCARD",
    ].join("\n");
    expect(parseVCards(vcf)[0]!.phone).toBe("302-555-0103");
  });

  it("prefers a pref number when none is marked cell, else the first that is not a fax", () => {
    const pref = "BEGIN:VCARD\nN:Stone;Ivy\nTEL;TYPE=home:302-555-0110\nTEL;TYPE=work;PREF=1:302-555-0112\nEND:VCARD";
    expect(parseVCards(pref)[0]!.phone).toBe("302-555-0112");
    const fax = "BEGIN:VCARD\nN:Stone;Ivy\nTEL;TYPE=fax:302-555-0111\nTEL;TYPE=home:302-555-0110\nEND:VCARD";
    expect(parseVCards(fax)[0]!.phone).toBe("302-555-0110");
  });

  it("reads vCard 4.0 tel: and mailto: values and quoted TYPE lists", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Nia Brook",
      'TEL;VALUE=uri;TYPE="voice,cell":tel:+1-302-555-0105',
      "EMAIL:mailto:nia@example.com",
      "END:VCARD",
    ].join("\n");
    expect(parseVCards(vcf)).toEqual([
      { row: 1, firstName: "Nia", lastName: "Brook", phone: "+1-302-555-0105", email: "nia@example.com", notes: undefined },
    ]);
  });

  it("falls back to FN when N is empty, and unescapes \\, \\; and \\\\", () => {
    const vcf = "BEGIN:VCARD\nN:;;;;\nFN:Dee\\, the Second\\\\\nTEL:302-555-0106\nEND:VCARD";
    expect(parseVCards(vcf)[0]).toMatchObject({ firstName: "Dee,", lastName: "the Second\\" });
  });

  it("keeps a suffix with the family name", () => {
    const vcf = "BEGIN:VCARD\nN:Pike;Rowan;;;Jr.\nTEL:302-555-0102\nEND:VCARD";
    expect(parseVCards(vcf)[0]).toMatchObject({ firstName: "Rowan", lastName: "Pike Jr." });
  });

  it("uses the family name as the first name when that is all N has", () => {
    const vcf = "BEGIN:VCARD\nN:Plumber;;;;\nTEL:302-555-0107\nEND:VCARD";
    expect(parseVCards(vcf)[0]).toMatchObject({ firstName: "Plumber", lastName: undefined });
  });

  it("🔑 keeps a card only with a name AND a phone or email; numbers by card position", () => {
    const vcf = [
      "BEGIN:VCARD\nFN:Name Only\nEND:VCARD", // 1: no way to reach them
      "BEGIN:VCARD\nTEL:302-555-0108\nEND:VCARD", // 2: nothing to call them
      "BEGIN:VCARD\nNOTE:just a note\nEND:VCARD", // 3: nothing at all
      "BEGIN:VCARD\nFN:Theo Lark\nTEL:302-555-0101\nEND:VCARD", // 4: kept
      "BEGIN:VCARD\nFN:Rowan Pike\nEMAIL:rowan@example.com\nEND:VCARD", // 5: kept
    ].join("\n");
    expect(parseVCards(vcf).map((r) => [r.row, r.firstName])).toEqual([
      [4, "Theo"],
      [5, "Rowan"],
    ]);
    expect(countVCards(vcf)).toBe(5);
  });

  it("skips vCard 2.1 base64 photos that run unindented until a blank line", () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:2.1",
      "N:Lark;Theo;;;",
      "PHOTO;ENCODING=BASE64;JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD",
      "2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8Q",
      "EBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQ",
      "",
      "TEL;CELL:302-555-0101",
      "END:VCARD",
    ].join("\r\n");
    expect(parseVCards(vcf)).toEqual([
      { row: 1, firstName: "Theo", lastName: "Lark", phone: "302-555-0101", email: undefined, notes: undefined },
    ]);
  });

  it("reads a thousand cards with photos without trouble", () => {
    const photo = ["PHOTO;ENCODING=b;TYPE=JPEG:" + "A".repeat(74), ...Array.from({ length: 200 }, () => " " + "B".repeat(74))];
    const cards = Array.from({ length: 1000 }, (_, i) =>
      ["BEGIN:VCARD", "VERSION:3.0", `N:Client;Number${i};;;`, ...photo, `TEL;type=CELL:302-555-${String(i).padStart(4, "0")}`, "END:VCARD"].join("\r\n"),
    ).join("\r\n");
    const started = Date.now();
    const rows = parseVCards(cards);
    expect(rows).toHaveLength(1000);
    expect(rows[999]).toMatchObject({ row: 1000, firstName: "Number999", phone: "302-555-0999" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("keeps the last card of a file cut off before END:VCARD", () => {
    expect(parseVCards("BEGIN:VCARD\nFN:Theo Lark\nTEL:302-555-0101")).toHaveLength(1);
  });

  it("strips a BOM and ignores anything outside a card", () => {
    expect(parseVCards("﻿junk\nFN:Outside\nBEGIN:VCARD\nFN:Theo Lark\nTEL:302-555-0101\nEND:VCARD\n")).toHaveLength(1);
  });

  it("clips fields to the import route's caps", () => {
    const vcf = `BEGIN:VCARD\nN:${"L".repeat(100)};${"T".repeat(100)}\nTEL:${"9".repeat(60)}\nNOTE:${"n".repeat(2500)}\nEND:VCARD`;
    const [r] = parseVCards(vcf);
    expect(r!.firstName.length).toBe(80);
    expect(r!.lastName!.length).toBe(80);
    expect(r!.phone!.length).toBe(40);
    expect(r!.notes!.length).toBe(2000);
  });

  it("returns nothing for text that is not a contacts file", () => {
    expect(parseVCards("First name,Phone\nTheo,1")).toEqual([]);
    expect(parseVCards("")).toEqual([]);
  });
});

describe("looksLikeVCard", () => {
  it("tells a contacts file from a CSV by its content", () => {
    expect(looksLikeVCard("﻿BEGIN:VCARD\r\nVERSION:3.0")).toBe(true);
    expect(looksLikeVCard("  \nbegin:vcard\n")).toBe(true);
    expect(looksLikeVCard("First name,Phone\nTheo,1")).toBe(false);
    expect(looksLikeVCard("Notes\nBEGIN:VCARD is a weird note")).toBe(false);
  });
});

describe("parseWeeklyHours", () => {
  const w = (startMin: number, endMin: number): HoursWindow => ({ startMin, endMin });
  const H = (h: number, m = 0) => h * 60 + m;
  const read = (text: string) => {
    const { days, unread } = parseWeeklyHours(text);
    return { days: Object.fromEntries([...days.entries()].sort((a, b) => a[0] - b[0])), unread };
  };

  it("reads the common shapes, one day per line", () => {
    const { days, unread } = read(
      [
        "Monday 9:00 AM - 6:00 PM",
        "Tue: 9am–6pm",
        "Wednesday 10:00 – 19:00",
        "Thursday9 AM — 6 PM",
        "Fri 9 a.m. to 5 p.m.",
        "Saturday 10am - noon",
        "Sunday Closed",
      ].join("\n"),
    );
    expect(unread).toEqual([]);
    expect(days).toEqual({
      0: "closed",
      1: [w(H(9), H(18))],
      2: [w(H(9), H(18))],
      3: [w(H(10), H(19))],
      4: [w(H(9), H(18))],
      5: [w(H(9), H(17))],
      6: [w(H(10), H(12))],
    });
  });

  it("reads Google's copy, where the day and its hours are on separate lines", () => {
    const { days, unread } = read("Monday\n9 AM–6 PM\nTuesday\nClosed\nWednesday (Labor Day)\n10 AM–2 PM\n");
    expect(unread).toEqual([]);
    expect(days).toEqual({ 1: [w(H(9), H(18))], 2: "closed", 3: [w(H(10), H(14))] });
  });

  it("reads Google's tab-separated table rows", () => {
    expect(read("Monday\t9 AM–6 PM").days).toEqual({ 1: [w(H(9), H(18))] });
  });

  it("reads day ranges, lists, weekdays, weekends and daily", () => {
    expect(read("Mon-Fri 9am-5pm").days).toEqual(
      Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, [w(H(9), H(17))]])),
    );
    expect(read("Weekdays 9-5\nWeekends closed").days).toEqual({
      0: "closed",
      1: [w(H(9), H(17))],
      2: [w(H(9), H(17))],
      3: [w(H(9), H(17))],
      4: [w(H(9), H(17))],
      5: [w(H(9), H(17))],
      6: "closed",
    });
    expect(Object.keys(read("Daily 10am-8pm").days)).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    expect(Object.keys(read("Mon, Wed & Fri: 9-5").days)).toEqual(["1", "3", "5"]);
    expect(Object.keys(read("Thursday through Saturday 9-5").days)).toEqual(["4", "5", "6"]);
    // A range wraps the end of the week.
    expect(Object.keys(read("Fri-Mon 10-6").days)).toEqual(["0", "1", "5", "6"]);
    expect(Object.keys(read("Mo-Fr 09:00-17:00").days)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("splits two day specs on one line", () => {
    expect(read("Mon-Fri 9am-5pm, Sat 10am-4pm; Sun closed").days).toEqual({
      0: "closed",
      1: [w(H(9), H(17))],
      2: [w(H(9), H(17))],
      3: [w(H(9), H(17))],
      4: [w(H(9), H(17))],
      5: [w(H(9), H(17))],
      6: [w(H(10), H(16))],
    });
  });

  it("🔑 reads a split shift with bare hours: 1-6 after 12 means PM", () => {
    expect(read("Mon 9-12, 1-6").days).toEqual({ 1: [w(H(9), H(12)), w(H(13), H(18))] });
    expect(read("Tue 10:30-2, 3-7:30").days).toEqual({ 2: [w(H(10, 30), H(14)), w(H(15), H(19, 30))] });
    // The second shift starts AFTER the first ends: 7 here is 7 PM, though a
    // bare 7 on its own would be 7 AM.
    expect(read("Wed 8-11, 7-10").days).toEqual({ 3: [w(H(8), H(11)), w(H(19), H(22))] });
  });

  it("🔑 reads a bare hour from 6 AM on, and each later time after the one before", () => {
    expect(read("Mon 9-5").days[1]).toEqual([w(H(9), H(17))]);
    expect(read("Mon 12-8").days[1]).toEqual([w(H(12), H(20))]);
    expect(read("Mon 11-7").days[1]).toEqual([w(H(11), H(19))]);
    expect(read("Mon 5-9").days[1]).toEqual([w(H(17), H(21))]);
    expect(read("Mon 9-9").days[1]).toEqual([w(H(9), H(21))]);
  });

  it("reads a bare end or start to fit the side that says am/pm", () => {
    expect(read("Mon 9-5pm").days[1]).toEqual([w(H(9), H(17))]);
    expect(read("Mon 1-5pm").days[1]).toEqual([w(H(13), H(17))]);
    expect(read("Mon 9am-5").days[1]).toEqual([w(H(9), H(17))]);
    expect(read("Mon 10am-12").days[1]).toEqual([w(H(10), H(12))]);
  });

  it("reads noon, midnight, a late night and open 24 hours", () => {
    expect(read("Fri noon-midnight").days[5]).toEqual([w(H(12), 1440)]);
    expect(read("Sat 6pm-12am").days[6]).toEqual([w(H(18), 1440)]);
    expect(read("Sat 18:00-00:00").days[6]).toEqual([w(H(18), 1440)]);
    expect(read("Sun open 24 hours").days[0]).toEqual([w(0, 1440)]);
  });

  it("reads 24-hour times, with and without a colon", () => {
    expect(read("Mon 09:00-17:30").days[1]).toEqual([w(H(9), H(17, 30))]);
    expect(read("Mon 0900-1730").days[1]).toEqual([w(H(9), H(17, 30))]);
    expect(read("Mon 9.30-18.00").days[1]).toEqual([w(H(9, 30), H(18))]);
  });

  it("puts lines it cannot read in unread, word for word, and keeps the rest", () => {
    const { days, unread } = read(
      [
        "Business hours",
        "Monday 9am-5pm",
        "Tuesday by appointment",
        "9am-5pm",
        "Wednesday 9am",
        "Thursday",
        "Friday 9-5",
        "Saturday 5pm-9am",
        "Call me for holiday hours",
      ].join("\n"),
    );
    expect(days).toEqual({ 1: [w(H(9), H(17))], 5: [w(H(9), H(17))] });
    expect(unread).toEqual([
      "Tuesday by appointment",
      "9am-5pm",
      "Wednesday 9am",
      "Thursday",
      "Saturday 5pm-9am",
      "Call me for holiday hours",
    ]);
  });

  it("does not take ordinary words for days", () => {
    const { days, unread } = read("We're closed on holidays\nMore hours soon\nSummer: 9-5");
    expect(days).toEqual({});
    expect(unread).toHaveLength(3);
  });

  it("merges two lines for the same day", () => {
    expect(read("Mon 9am-12pm\nMon 1pm-6pm").days[1]).toEqual([w(H(9), H(12)), w(H(13), H(18))]);
  });

  it("never throws, whatever is pasted", () => {
    for (const junk of ["", "\n\n", "----", "Mon - - -", "Mon 99-100", "Mon 13pm-2pm", "Mon 9:75-10", "x".repeat(10000)]) {
      expect(() => parseWeeklyHours(junk)).not.toThrow();
    }
    expect(parseWeeklyHours(undefined as unknown as string)).toEqual({ days: new Map(), unread: [] });
    expect(read("Mon 13pm-2pm").unread).toEqual(["Mon 13pm-2pm"]);
  });
});
