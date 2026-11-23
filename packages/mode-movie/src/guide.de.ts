import type { GuideTopic } from '@imp/core';

/**
 * The guide's pages about the movie stages in German, each with the tip shown
 * the first time the stage opens. Each page has the id of its English original
 * in guide.ts and says the same; a test checks that none is missing.
 */
export const movieGuidesDe: readonly GuideTopic[] = [
  {
    id: 'stage-development',
    area: 'development',
    title: 'Entwicklung',
    summary: 'Die Idee des Films, bevor es ein Drehbuch gibt: Logline, Prämisse, Ton, Treatment.',
    hint: {
      title: 'Fang mit der Idee an',
      body: 'Schreib eine Logline und die Geschichte in ein paar Absätzen, oder erzähl dem Koordinator deine Idee in einem Satz und lass den Drehbuchautor einen Entwurf schreiben. Alles Spätere baut auf dieser Seite auf.',
    },
    body: `Die Entwicklung enthält, was der Film ist, bevor es ein Drehbuch gibt: die **Logline** (der Film in ein, zwei Sätzen), die **Prämisse** (die Ausgangslage, die Hauptfigur und was auf dem Spiel steht), den **Ton** (Genre, Stimmung und Bildsprache) und das **Treatment** (die Geschichte in Prosa, vom Anfang bis zum Ende).

## Was du hier tust

1. Schreib die Logline: Wer will was, und was steht im Weg?
2. Schreib die Prämisse und dann das Treatment.
3. Beschreib die Bildsprache im Ton in Worten (zum Beispiel „körniger 16-mm-Film, kalte Blautöne, Handkamera“). Bilder der Welt werden darin gezeichnet, damit der Film wie ein Film aussieht.

## Lass die Crew ran

Erzähl dem Koordinator die Geschichte in einem Satz. Er stellt einen **Drehbuchautor** ein, der die Entwicklung schreibt. Danach kannst du jedes Wort ändern.

## Kontrollpunkte

Die Crew hält an drei Stellen für dich an, damit nichts Teures entsteht, bevor du es gesehen hast: beim **Treatment** (hier), beim **Storyboard** jeder Szene (in Einstellungen) und beim **Rohschnitt** jeder Szene (im Schnitt). Drück **Freigeben**, wenn es passt; Casting, Ausstattung und die Szenen warten auf das Treatment, die Clips einer Szene auf ihr Storyboard. **Wie viel die Crew selbst macht** legt fest, wo sie anhält: an jedem Kontrollpunkt, nur beim Storyboard oder nirgends. Ausgaben bleiben immer im Budget.

## Tipps

- Kurzfilme funktionieren am besten mit einer Hauptfigur und einer klaren Wendung.
- Eine klare Bildsprache ist eine Minute wert: Sie ist der günstigste Weg, einen langen Film stimmig zu halten.`,
  },
  {
    id: 'stage-script',
    area: 'script',
    title: 'Drehbuch',
    summary: 'Szenen und Drehbuch: was passiert, wo, wer spricht.',
    hint: {
      title: 'Teil die Geschichte in Szenen',
      body: 'Jede Szene bekommt einen Ort, eine Tageszeit, eine Handlung und ihre Zeilen. Bitte den Drehbuchautor, sie aus der Entwicklung zu entwerfen, und schreib dann um, was du willst.',
    },
    body: `Das Drehbuch enthält die **Szenen** des Films in ihrer Reihenfolge. Jede Szene hat eine Überschrift (Ort und Tageszeit), eine Zusammenfassung dessen, was passiert, das Drehbuch mit Handlung und Dialog und wahlweise den Ort aus der Ausstattung, an dem sie spielt. Die Kopfzeile zeigt, wie lang das Drehbuch läuft: Eine Seite ist etwa eine Minute Film.

## Eine Szene schreiben

Szenen werden in **Fountain** geschrieben, dem Klartextformat für Drehbücher, das Drehbuchprogramme nutzen, und als richtige Drehbuchseite angezeigt. Wechsle über der Szene zwischen **Seite** und **Schreiben**.

- Der Name einer Figur in Großbuchstaben auf eigener Zeile spricht die Zeilen darunter. Häng (V.O.) oder (O.S.) an, wenn die Figur nicht zu sehen ist.
- Wie eine Zeile gesagt wird, steht in Klammern auf eigener Zeile: (flüsternd).
- Übergänge stehen in Großbuchstaben und enden auf TO:, etwa CUT TO:.
- *Kursiv* und **fett** heben hervor.
- Beim Schreiben macht **Tab** aus der Zeile den nächsten Teil (Handlung, Figur, Regieanweisung, Dialog, Übergang), Umschalt+Tab geht zurück. Die Schaltflächen über dem Text tun auf dem Tablet dasselbe, und die Namen der Besetzung sind einen Tipp entfernt.

## Drehbuch und Einstellungen

Auf der Seite zeigt jede Dialogzeile die Einstellung, die sie spricht, oder „keine Einstellung“. In den Einstellungen füllt **Aus dem Drehbuch** Zeile, Sprecher und Vortrag einer Einstellung aus dem Drehbuch. Zeilen, die in Einstellungen gesprochen werden, aber nicht im Drehbuch stehen, erscheinen unter der Szene, bereit zum Übernehmen.

## Dateien

**Importieren** holt ein Drehbuch in Fountain oder Final Draft (.fdx) als neue Szenen herein. **Herunterladen** schreibt das Drehbuch als PDF im üblichen Drehbuchformat, als Fountain oder als Final Draft.

## Was du hier tust

1. Füg Szenen selbst mit dem Plus hinzu, oder bitte den Drehbuchautor, die Zusammenfassung in Szenen aufzuteilen.
2. Öffne eine Szene über die Reiter, um sie zu schreiben oder umzuschreiben, und verknüpf sie mit ihrem Ort.
3. Schreib Zeilen so, wie sie gespielt werden sollen. „Weg vom Geländer!“ klingt lauter als „Weg vom Geländer.“

## Wie Szenen später genutzt werden

- Das Casting findet die Figuren, die sprechen.
- Die Einstellungen teilen jede Szene in Einstellungen auf, und die Clips sprechen jede Zeile lippensynchron.
- Der Schnitt legt jede Szene als eigene Zeitleiste an und fügt sie zum Film zusammen.

## Lass die Crew ran

Der **Drehbuchautor** schreibt und überarbeitet Szenen. Bitte in einfachen Worten um eine Änderung: „Mach Szene 3 kürzer und gib Mara die letzte Zeile.“`,
  },
  {
    id: 'stage-casting',
    area: 'casting',
    title: 'Casting',
    summary: 'Figuren mit Beschreibung, Porträts und Stimme.',
    hint: {
      title: 'Gib jeder Figur ein Gesicht und eine Stimme',
      body: 'Beschreib jede Figur und erstelle dann ein Porträt und eine Stimmprobe. Die Einstellungen nutzen das Porträt, damit in jedem Clip dasselbe Gesicht erscheint. Jedes Porträt und jede Stimme kostet ein, zwei Cent.',
    },
    body: `Das Casting enthält die **Figuren** des Films: eine Beschreibung, Porträts und eine Stimme.

## Was du hier tust

1. Füg eine Figur hinzu, oder lass den **Casting-Direktor** sie im Drehbuch finden.
2. Schreib, wie sie aussieht: Alter, Statur, Gesicht, Kleidung. Sei genau; das Porträt folgt der Beschreibung.
3. Erstelle ein **Porträt**. Erstelle ein paar und wähle das, das dir gefällt; das gewählte Porträt leitet jeden Clip, in dem die Figur vorkommt.
4. Erstelle eine **Stimme**: Beschreib, wie die Figur spricht, und probier eine Beispielzeile mit einer Anweisung wie „ruhig“ oder „panisch“.

## Kosten

Ein Porträt kostet mit einem günstigen Bildmodell etwa einen Cent, eine Stimmprobe etwas mehr. Der Preis steht auf der Schaltfläche, bevor du sie drückst.

## Tipps

- Zieh ein beliebiges Bild aus der Bibliothek auf eine Figur, um es als ihr Porträt zu nutzen.
- Ändere Beschreibungen nicht mehr, sobald es Clips gibt, damit spätere Clips zu früheren passen.`,
  },
  {
    id: 'stage-design',
    area: 'design',
    title: 'Ausstattung',
    summary: 'Orte und Objekte, gezeichnet von jeder Seite, von der die Kamera sie sieht.',
    hint: {
      title: 'Bau die Welt einmal und nutz sie überall',
      body: 'Füg die Orte und wichtigen Objekte des Films hinzu. Jedes bekommt Bilder aus den Blickwinkeln, die die Kamera braucht, und Zustände wie „Nacht“ oder „nach dem Sturm“, damit jede Einstellung davon zusammenpasst.',
    },
    body: `Die Ausstattung enthält die **Orte** und **Objekte** des Films. Jedes hat Ansichten (die Seiten, die die Kamera sieht) und Zustände (Nacht, Regen, verwüstet), gezeichnet in der Bildsprache des Films.

## Was du hier tust

1. Füg einen Ort hinzu, etwa „die Küche im Leuchtturm“, und beschreib ihn.
2. Erstelle seine Ansichten: Totale, Gegenschuss, Details. Sie werden zu Referenzbildern für Einstellungen, die dort spielen.
3. Füg Zustände hinzu, wenn sich ein Ort im Lauf des Films verändert.
4. Mach dasselbe für Objekte, die für die Geschichte wichtig sind, etwa einen Brief oder ein Auto.

## Lass die Crew ran

Der **Szenenbildner** liest das Drehbuch, findet die Orte und Objekte und zeichnet sie.

## Warum es wichtig ist

Videomodelle vergessen zwischen zwei Clips, wie ein Raum aussah. Gibst du jeder Einstellung dieselben Ortsbilder mit, bleibt ein langer Film stimmig.`,
  },
  {
    id: 'stage-shots',
    area: 'shots',
    title: 'Einstellungen',
    summary: 'Jede Szene in Einstellungen aufgeteilt, aus jeder Einstellung ein Videoclip.',
    hint: {
      title: 'Erst Einstellungen planen, dann Clips erstellen',
      body: 'Beschreib jede Einstellung (Bildausschnitt, Handlung, wer darin ist), wähle einen Keyframe, wenn der Clip mit einem festen Bild beginnen soll, und erstelle dann den Clip. Clips sind der teuerste Teil eines Films: Der Preis steht auf der Schaltfläche, und ein Keyframe ist vorher eine günstige Probe.',
    },
    body: `Die Einstellungen teilen jede Szene in **Einstellungen** auf und machen aus jeder einen **Videoclip**.

## Was du hier tust

1. Wähle über die Reiter eine Szene.
2. Füg Einstellungen hinzu: Bildausschnitt (Totale, Großaufnahme), was passiert, wer darin ist und wie lange sie **im Schnitt dauert**, mit einem Wort zum Warum. Wechsle die Längen: Ein Blick ist nach ein, zwei Sekunden vorbei, ein Moment, der wirken soll, braucht länger. Der Clip wird etwas länger erstellt, damit der Schnitt ihn im besten Moment schneiden kann.
3. Erstelle wahlweise einen **Keyframe**, ein Standbild, mit dem der Clip beginnt. Er ist günstig und lässt dich den Look prüfen, bevor du für Video bezahlst. Ein **Schlussbild** legt fest, wo der Clip landet, bei Modellen, die eines annehmen.
4. Leg fest, wie jede Einstellung **auf die vorige folgt**: neuer Blickwinkel oder Ort; *führt dieselbe Aufnahme fort*, dann beginnt der Clip mit dem letzten Bild der vorigen und die Handlung fließt weiter (er wird nach jenem Clip erstellt); oder ein *Schnitt in der Bewegung*, derselbe Moment aus neuem Blickwinkel, dessen Keyframe passend zum Ende der vorigen Einstellung gemalt wird. Schreib dazu, warum dort geschnitten wird; der Film Editor liest es.
5. Gib einer Einstellung mit Sprechrolle ihre **Zeile** und den Vortrag. Der Clip spricht sie selbst, lippensynchron, zusammen mit den Geräuschen der Szene.
6. Erstelle den **Clip**. Das dauert ein, zwei Minuten. Die Porträts der Figuren in der Einstellung und die Ortsbilder gehen mit. Clips haben immer Ton; Videomodelle ohne Ton werden nicht angeboten.
7. Für einen Erzähler oder eine Stimme aus dem Off **nimm den Dialog** mit der Stimme dieser Figur auf; er läuft über den Clip.

## Takes

Erstellst du einen Clip neu, wird der alte nie weggeworfen. Frühere Clips bleiben als **Takes** unter dem Clip; tippe einen an, um ihn anzusehen und wieder zu verwenden.

## Kosten

Ein Clip von 4 Sekunden kostet je nach Modell und Auflösung etwa 15 bis 40 Cent. Der Preis steht vor jedem Clip auf der Schaltfläche, und die Summe steht in der oberen Leiste.

## Lass die Crew ran

Der **Clip-Designer** plant zuerst die Einstellungen einer Szene und malt ihre Keyframes: Das ist das **Storyboard**. Sieh dir die Bilder der Reihe nach an und drück über den Einstellungen auf **Freigeben**, wenn die Szene funktioniert; erst dann entstehen ihre Clips, denn Bilder kosten Cents und Clips Dollars.`,
  },
  {
    id: 'stage-sound',
    area: 'sound',
    title: 'Ton',
    summary: 'Musik und zusätzlicher Ton, wo eine Szene mehr braucht, als ihre Clips mitbringen.',
    hint: {
      title: 'Clips bringen ihren eigenen Ton mit',
      body: 'Beschreib einen Ton („Wellen, die nachts an Felsen brechen“) oder ein Musikstück, und Imp erstellt es. Töne kommen in die Szene und lassen sich auf die Zeitleiste im Schnitt legen oder im Audio-Editor öffnen.',
    },
    body: `Clips bringen ihren eigenen Ton mit: Stimmen, Geräusche und die Atmosphäre des Ortes. Ton enthält, was eine Szene darüber hinaus braucht: **Musik**, eine durchgehende **Atmo**, wo die Hintergründe der Clips an den Schnitten springen, oder einen **Effekt**, den kein Clip macht.

## Was du hier tust

1. Wähle eine Szene.
2. Beschreib einen Soundeffekt. Fang mit dem an, was den Ton macht: „eine schwere Tür, die in einer leeren Halle zuschlägt“.
3. Beschreib Musik: Stimmung, Instrumente, Tempo und „instrumental, ohne Gesang“, wenn du das willst.
4. Hör es dir an und erstelle es neu, wenn es nicht passt.

## Die Töne nutzen

- Zieh im Schnitt einen Ton im richtigen Moment auf die Audiospur.
- Öffne jeden Ton im **Audio**-Editor, um ihn zu kürzen, seine Lautheit zu ändern oder Effekte hinzuzufügen.

## Lass die Crew ran

Der **Sounddesigner** ergänzt Ton, wenn du darum bittest oder wenn dem Rohschnitt einer Szene etwas fehlt, sobald du ihn freigegeben hast.`,
  },
  {
    id: 'stage-edit',
    area: 'edit',
    title: 'Schnitt',
    summary: 'Clips, Ton und Text zum Film zusammenfügen und ihn exportieren.',
    hint: {
      title: 'Setz den Film zusammen',
      body: 'Der Filmstreifen zeigt den ganzen Film, einen Block pro Szene. Öffne eine Szene, um ihre Einstellungen zu schneiden, Ton zu platzieren und Titel hinzuzufügen. Bild und Ton werden getrennt bearbeitet. Exportiere den Film über das Menü, wenn er fertig ist.',
    },
    body: `Im Schnitt werden aus Clips ein Film. Imp gibt es, um Filme beliebiger Länge zu machen, die zusammenhalten, und hier passiert das.

## Der Film und seine Szenen

- Der **Filmstreifen** zeigt jede Szene als Block, so lang wie die Szene: grün, wenn alle ihre Stücke fertig sind, gelb, solange welche fehlen.
- Öffne eine Szene, um ihre **Zeitleiste** zu sehen: Bilder auf einer Spur, Ton auf eigenen Spuren, Text auf einer weiteren.
- Die Wiedergabe läuft von einer Szene in die nächste weiter, sodass du den Film am Stück ansehen kannst.

## Das Animatic

Solange eine Einstellung noch keinen Clip hat, steht ihr Keyframe im Schnitt als Standbild, so lange, wie die Einstellung halten soll, mit ihrem Satz darunter. Eine in Einstellungen geplante Szene läuft hier darum als **Animatic**: Sieh sie dir an und ändere Reihenfolge oder Längen, solange das nichts kostet. Exportiert ergibt sie einen Film aus Standbildern. Jeder Clip nimmt den Platz seines Standbilds ein, sobald er fertig ist.

## Schneiden

- Kürze ein Stück, indem du seine Ränder ziehst; teile es am Abspielkopf; zieh Stücke, um sie umzuordnen.
- **Auf geplante Länge kürzen** (die nach innen zeigenden Pfeile) macht einen ersten Schnitt: Jede Einstellung wird auf ihre geplante Dauer gekürzt, ein wenig am Anfang und der Rest am Ende. Ist ein Stück gewählt, nur dieses. Danach schiebst du die Ränder auf den besten Moment.
- Wähle ein Stück, um seinen Inspektor zu sehen: Takes, Tempo, Standbild, Zoom, Farbkorrektur und wie es hereinkommt (Schnitt, Überblendung, Abblende, Wischblende).
- **Übergänge**: Wähle das zweite von zwei Stücken und leg unter *Kommt herein mit* fest, wie es kommt: harter Schnitt, Überblendung, Abblende auf Schwarz oder Weiß oder Wischblende. **Länge (s)** unter der Auswahl bestimmt, wie lange das dauert (0,1 bis 5 Sekunden). Eine Überblendung oder Wischblende liegt über dem vorigen Stück, die Szene wird also um so viel kürzer; eine Abblende behält ihre Länge.
- **J- und L-Schnitte** lassen den Ton einer Einstellung früher beginnen oder unter der nächsten weiterlaufen.
- Setz mit M **Marker** (Notizen, Aufgaben, Probleme) am Abspielkopf.
- Rückgängig und Wiederherstellen funktionieren für jede Änderung.

## Ton und Text

- Zieh Töne aus dem Ton oder der Bibliothek auf die Audiospur.
- Die Textspur enthält Titel, Bauchbinden, Einblendungen, Untertitel und Abspann.
- Wähle einen Text, um einzelne Wörter zu gestalten (fett, kursiv, unterstrichen, eine Farbe, kleiner oder größer) und ihn auf dem Bild zu verschieben. Er rastet an der Mitte und am sicheren Bereich ein und wird rot, wo manche Bildschirme ihn abschneiden könnten.
- Untertitel, die zu schnell zum Lesen sind, werden auf der Spur markiert.

## Mit dem Cutter arbeiten

Der **Cutter** kann ebenfalls schneiden. Seine Änderungen kommen als **Vorschlag**, wie Änderungen im Überarbeitungsmodus: Spiel ihn ab und behalte oder verwirf dann jede Änderung. Markiere mit In und Out (I und O) einen Abschnitt, und deine nächste Nachricht bezieht sich nur auf diesen Abschnitt. Der **Kritiker**, eine Zusatzrolle, die du auf der Seite Crew unter Weitere Rollen hinzufügst, sieht sich den Film an und setzt Marker.

## Exportieren

Der Export rendert die Szene oder den ganzen Film als MP4-Datei, schneller als in Echtzeit: im Browser oder mit ffmpeg auf dem lokalen Server, wo Imp anbietet, ffmpeg herunterzuladen, falls es fehlt.

## Wo fertige Filme landen

Jeder fertige Film bleibt im Projekt. Alle findest du in der **Bibliothek** unter **Filme**, die neuesten auch im **Export**-Fenster. Jeder zeigt, wann und von wem er gemacht wurde und wie lang er ist, mit **Abspielen** und **Speichern unter …**, das fragt, wo die MP4-Datei hin soll. Macht ein Agent einen Film fertig, erscheint ein Hinweis mit **Ansehen**, und seine Antwort im Chat trägt dieselbe Karte.`,
  },
  {
    id: 'stage-audio',
    area: 'audio',
    title: 'Audio',
    summary:
      'Ein vollständiger Audio-Editor: Spuren, Effekte, Lautheit, Aufnahme, Dialog nach Wörtern.',
    hint: {
      title: 'Feile am Ton wie im Studio',
      body: 'Öffne eine Szene oder einen einzelnen Ton als Audiodokument. Ordne Bereiche auf Spuren an, füg Effekte hinzu, stell die Lautheit ein, nimm mit R vom Mikrofon auf und bearbeite Dialog nach seinen Wörtern.',
    },
    body: `Audio ist ein vollständiger Audio-Editor für alles im Film: den ganzen Ton einer Szene oder einen einzelnen Ton.

## Was du tun kannst

- **Bereiche** auf **Spuren** anordnen, kürzen, teilen, ein- und ausblenden und verschieben.
- **Effekte** auf einen Bereich oder eine Spur legen: EQ, Kompressor, Limiter, Rauschminderung und Stimmen wie Telefon, Radio, Roboter, Megafon oder Monster.
- Die **Lautheit** einstellen, damit der Film von Szene zu Szene gleichmäßig klingt.
- Mit R am Abspielkopf vom Mikrofon **aufnehmen**.
- **Dialog nach seinen Wörtern** bearbeiten: Wähle Wörter, dann „Aufschreiben, was gesagt wird“. Tippe ein Wort und ein weiteres an, um alles dazwischen zu wählen, dann Löschen, Stummschalten oder mit Strg+X und Strg+V verschieben.

## Ton hereinholen

Zieh einen Ton aus der Bibliothek auf eine Spur (auf dem Tablet vorher kurz gedrückt halten), oder wähle bei einem beliebigen Ton „Im Audio-Editor öffnen“.

## Lass die Crew ran

Der **Toncutter** mischt, säubert und pegelt Ton mit denselben Werkzeugen.`,
  },
];
