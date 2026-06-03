# Navodila za uporabo

Pozdravljen! Ta navodila te bodo po korakih popeljala skozi namestitev in uporabo programa. Pisana so čisto preprosto, tako da ti ni treba znati nič o računalnikih. Le sledi korakom od zgoraj navzdol in vse bo v redu.

---

## Kaj ta program počne?

Program ti pomaga pri prijavah na študentska dela na portalu **studentski-servis.com**.

Na kratko: program odpre seznam oglasov za delo, pogleda najnovejše oglase in se na vsak nov oglas namesto tebe prijavi. Za vsak oglas bodisi pridobi kontaktni e-naslov bodisi sam izpolni in odda spletni obrazec za prijavo ter pripne tvoj življenjepis (CV).

Program si tudi zapomni, na katere oglase se je že prijavil, zato se ne prijavi dvakrat na isti oglas. Vse rezultate shrani na tvoj računalnik v datoteko (**jobs.csv**), da jih lahko kasneje pogledaš.

---

## Kaj potrebuješ?

Preden začneš, preveri, da imaš naslednje:

- **Računalnik z operacijskim sistemom Windows 10 ali Windows 11.**
- **Povezavo z internetom.**
- **Svoj življenjepis (CV) v obliki PDF.** (To je običajna datoteka s končnico `.pdf`. Če imaš CV v Wordu, ga lahko shraniš kot PDF z izbiro "Shrani kot" -> "PDF".)
- **Nič posebnega ni potrebno za osnovno uporabo.** Rezultati se preprosto shranijo v datoteko na tvojem računalniku.

> **Opomba:** Če bi želel(a), da program tudi samodejno pošilja e-pošto, bi potreboval(a) Gmail račun. **Ampak za osnovno uporabo tega ne potrebuješ** -- rezultati se vseeno lepo shranijo v datoteko in jih lahko pogledaš.

---

## 1. korak: Namestitev

To narediš samo **enkrat**. Ko je program enkrat nameščen, ti tega ni treba nikoli več ponavljati.

1. V mapi programa poišči datoteko **`1-Namesti.bat`** in jo **dvoklikni**.

2. Lahko se zgodi, da Windows pokaže **modro okno** z napisom *"Windows protected your PC"* (Windows je zaščitil vaš računalnik). **Ne skrbi, to je povsem normalno.** Naredi takole:
   - Klikni na **"Več informacij"** (angl. *More info*).
   - Nato klikni na gumb **"Vseeno zaženi"** (angl. *Run anyway*).

3. Med namestitvijo se lahko pojavi eno ali več oken, ki te vprašajo za dovoljenje (Windows vpraša: *"Ali dovolite tej aplikaciji ...?"*). Pri vsakem takem oknu klikni **"Da"** (angl. *Yes*).

4. Zdaj samo **počakaj**. Program si bo sam namestil vse, kar potrebuje za delovanje. To lahko traja **nekaj minut** -- to je čisto normalno, zato bodi potrpežljiv(a) in ne zapiraj okna.

5. Ko se namestitev konča, ti bo program to sporočil. Takrat je vse pripravljeno!

> **Namig:** Če se ti zdi, da se nič ne dogaja, počakaj še malo. Namestitev v ozadju nalaga datoteke z interneta in to lahko traja.

---

## 2. korak: Zagon programa

Tole boš počel(a) vsakič, ko boš želel(a) uporabiti program.

1. Dvoklikni datoteko **`2-Zazeni.bat`**. (Lahko pa uporabiš tudi ikono na namizju z imenom **"Studentski servis - Prijave"**, če se je ustvarila.)

2. Odprli se bosta **dve stvari**:
   - **Črno okno.** To je "motor" programa. **Pusti ga odprtega, dokler uporabljaš program.** Če ga zapreš, se program ustavi.
   - **Stran v tvojem spletnem brskalniku.** To je nadzorna plošča programa -- mesto, kjer boš vse upravljal(a) s klikanjem gumbov. Stran se odpre samodejno.

> **Če se stran v brskalniku ne odpre sama:** odpri svoj brskalnik (npr. Chrome, Edge ali Firefox), v naslovno vrstico na vrhu vpiši **`http://127.0.0.1:8731`** in pritisni Enter. Pomembno: črnega okna pri tem ne zapiraj.

---

## 3. korak: Prva uporaba (varni preizkus)

Zdaj si na strani v brskalniku. Tukaj boš vse uredil(a) s klikanjem. Pojdi po vrsti:

1. **Naloži svoj CV.** Poišči gumb za nalaganje datoteke in izberi svoj življenjepis v obliki PDF.

2. **Uredi sporočilo (neobvezno).** Če želiš, lahko spremeniš besedilo sporočila oziroma spremnega pisma, ki se pošlje skupaj s prijavo. Če ti je vseeno, lahko to preskočiš.

3. **Klikni zeleni gumb "Testni zagon (varno)".** To je **varen preizkus**. Program bo odprl brskalnik in poiskal službe, **vendar v resnici ne bo oddal nobene prijave.** Tako lahko brez skrbi vidiš, kako program deluje.

4. **Prijavi se v Studentski servis.** Ko se odpre novo okno brskalnika (imenuje se Chromium), se v njem **prijavi v svoj račun na Studentskem servisu** (vpiši svoje uporabniško ime in geslo). To moraš narediti **samo prvič** -- program si prijavo zapomni, zato ti tega naslednjič ne bo treba ponavljati. Ko si prijavljen(a), program nadaljuje sam.

5. **Opazuj dogajanje.** Na strani v brskalniku boš videl(a) **dnevnik v živo** -- to je sproten zapis, ki ti pokaže, kaj program počne. Mirno ga opazuj.

> **To je le preizkus.** Pri "Testnem zagonu" se ne odda nič. Šele v naslednjem koraku se prijave dejansko oddajo.

---

## 4. korak: Pravi zagon (dejanska oddaja prijav)

Ko si zadovoljen(a) s tem, kar si videl(a) pri preizkusu, lahko narediš pravo prijavo.

1. Klikni gumb **"Pravi zagon"**.

2. Zdaj bo program **zares oddal prijave** -- izpolnil in poslal obrazce oziroma poslal e-pošto, kjer je to potrebno.

3. Spet lahko **opazuješ dnevnik v živo** in spremljaš, kaj se dogaja.

> **Priporočilo:** Vedno naredi najprej **"Testni zagon"**, šele nato "Pravi zagon". Tako si na varnem in vnaprej vidiš, kaj se bo zgodilo.

---

## Kje so rezultati?

Rezultate najdeš na dveh mestih:

- **Kratek povzetek na strani v brskalniku.** Po koncu zagona se prikaže kratko poročilo -- na primer koliko oglasov je program pregledal in na koliko se je prijavil.

- **Datoteka `jobs.csv`.** Podrobnosti o vseh oglasih so shranjene v datoteki **`jobs.csv`**, ki se nahaja v mapi programa. To datoteko lahko odpreš z Excelom ali podobnim programom in si ogledaš vse podrobnosti.

---

## Pogosta vprašanja in težave

**Modro okno Windows me ustavi ("Windows protected your PC").**
To je normalno in nenevarno. Klikni **"Več informacij"** in nato **"Vseeno zaženi"**. Program se bo zagnal.

**V brskalniku se nič ne odpre.**
Najprej preveri, da črno okno **ni zaprto** -- mora ostati odprto. Nato sam(a) odpri brskalnik in v naslovno vrstico vpiši **`http://127.0.0.1:8731`** ter pritisni Enter. Stran bi se morala prikazati.

**Brskalnik se odpre, ampak program ne najde nobene službe.**
To se najpogosteje zgodi, ker se **nisi prijavil(a) v Studentski servis** v oknu, ki se je odprlo. Vrni se v to okno, vpiši svoje uporabniško ime in geslo na Studentskem servisu, in program bo nadaljeval.

**Ali moram vsakič znova namestiti program?**
Ne! **Namestitev (`1-Namesti.bat`) narediš samo enkrat.** Po tem za vsako uporabo dvoklikneš samo **`2-Zazeni.bat`**.

**Ali lahko zaprem črno okno?**
Ne, dokler uporabljaš program. Črno okno je "motor", ki poganja program. Ko končaš z delom, ga lahko zapreš in s tem program ustaviš.

---

## Pomembno opozorilo in odgovornost

Prosim, preberi tole, preden začneš uporabljati program.

To je **starejši ljubiteljski projekt**, ki je deljen takšen, kakršen je ("as is"), brez kakršnihkoli zagotovil.

- **Samodejno prijavljanje in oddajanje prijav najverjetneje krši pogoje uporabe Studentskega servisa.** Zaradi tega bi bil lahko tvoj račun označen, začasno onemogočen ali celo trajno zaprt.
- **Program uporabljaš na lastno odgovornost.** Avtor ne prevzema nikakršne odgovornosti za morebitne posledice.
- **Spletna stran se lahko kadarkoli spremeni** in zaradi tega lahko program preneha delovati pravilno.

Zato priporočamo, da **vedno najprej narediš "Testni zagon"** in šele nato razmisliš o pravem zagonu. Tako boš vedno videl(a), kaj se bo zgodilo, preden se kaj dejansko zgodi.

---

Želimo ti veliko sreče pri iskanju študentskega dela!
