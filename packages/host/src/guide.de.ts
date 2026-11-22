import type { GuideTopic } from '@imp/core';

/**
 * Imp's own guide pages in German. Each page has the id of its English
 * original in guide.ts and says the same; a test checks that none is missing.
 * Buttons are named as the German interface shows them.
 */
export const workspaceGuidesDe: readonly GuideTopic[] = [
  {
    id: 'getting-started',
    area: 'workspace',
    title: 'Erste Schritte',
    summary: 'Was Imp ist, wie darin ein Film entsteht und der schnellste Weg zum ersten Film.',
    body: `Imp macht Filme beliebiger Länge aus KI-erzeugten Bildern, Stimmen, Tönen und Videoclips und hält sie von der ersten bis zur letzten Szene stimmig. Du kannst jeden Schritt selbst machen, jeden Schritt einem KI-Agenten übergeben oder beides mischen.

Auf Englisch steht der Name für **Imp Makes Pictures**, ein Name, der sich selbst enthält, ganz im Geist von GNU. Auf Deutsch malt Imp eben Pixel: **Imp Malt Pixel**. Auf der Projektseite probiert der Kobold bei jedem Besuch eine andere Bedeutung aus (Imp Montiert Perfekt, Ideen Machen Premieren, Immer Mehr Pixel und mehr); tippe auf die Zeile über der Überschrift, um die nächste zu sehen.

## Wie ein Film entsteht

Die Phasen links folgen dem Weg, auf dem Filme entstehen. Besuche sie in beliebiger Reihenfolge:

1. **Entwicklung**: die Idee, die Prämisse und der Ton.
2. **Drehbuch**: die Szenen und ihre Dialoge.
3. **Casting**: Figuren mit Porträts und Stimmen.
4. **Ausstattung**: die Orte und Objekte, damit jede Einstellung eines Orts zusammenpasst.
5. **Einstellungen**: jede Szene in Einstellungen aufgeteilt, aus jeder Einstellung ein Videoclip.
6. **Ton**: Effekte und Musik.
7. **Schnitt**: alles zum Film zusammengefügt und dann exportiert.
8. **Audio**: ein vollständiger Audio-Editor für die Feinarbeit am Ton.

## Der schnellste Weg zum ersten Film

Erzähl dem **Koordinator** (die Leiste rechts) deine Geschichte in einem Satz, zum Beispiel „eine Leuchtturmwärterin findet eine Flaschenpost, die an sie adressiert ist“. Er plant die Arbeit, stellt die nötige Crew ein und führt dich durch jede Phase. Er fragt, bevor etwas Geld kostet.

## Dein erster Film, Schritt für Schritt

Solange Tipps an sind, zeigt eine schmale Leiste über jeder Phase die sechs Schritte zum ersten Film: sagen, worum es im Film geht, eine Szene schreiben, eine Figur besetzen, die Einstellungen planen, einen Clip erstellen und zusammenschneiden. Die Schritte haken sich selbst ab, je nachdem, was das Projekt enthält. Öffne die Leiste, um alle zu sehen; **Gehe zu** bringt dich zur Phase, und **Den Koordinator fragen** schreibt die Bitte in sein Nachrichtenfeld, damit du sie abschickst. Das × blendet die Leiste dauerhaft aus.

## Vom Beispielfilm lernen

Auf der Seite **Projekte** erstellt **Beispielfilm öffnen** eine Kopie von „Das letzte Licht“, einem Kurzfilm in drei Szenen, ausgearbeitet bis zu jeder Einstellung, Zeile und jedem Ton. Darin ist noch nichts erzeugt, das Öffnen kostet also nichts. Geh durch die Phasen, um zu sehen, wie ein fertiger Plan aussieht, und erstelle dann das Bild oder den Clip einer Einstellung, um den nächsten Schritt zu sehen; der Preis steht auf der Schaltfläche. Die Kopie gehört dir, ändere oder lösche sie nach Belieben. (Agenten öffnen sie mit project.create und der Vorlage movie.sample-last-light.)`,
  },
  {
    id: 'crew-and-agents',
    area: 'workspace',
    title: 'Die Crew: Arbeiten mit KI-Agenten',
    summary:
      'Der Koordinator, die Rollen, die du einstellen kannst, und wie du ihnen Arbeit gibst.',
    body: `Imps KI-Agenten heißen die **Crew**. Jeder wird für eine Rolle eingestellt und läuft auf einem Modell deiner Wahl.

## Der Koordinator

Der Koordinator ist der Agent in der Leiste rechts. Sprich mit ihm wie mit einem Produzenten: Sag, was du willst, und er plant, stellt ein und verteilt die Arbeit. Er kann Optionen ändern und Dinge für dich einrichten.

## Rollen

- **Drehbuchautor**: Entwicklung und Szenen.
- **Casting-Direktor**: Figuren, Porträts und Stimmen.
- **Szenenbildner**: Orte und Objekte.
- **Clip-Designer**: Einstellungen und Videoclips.
- **Sounddesigner**: Soundeffekte und Musik.
- **Cutter**: schneidet Szenen; seine Änderungen kommen als Vorschläge, die du behältst oder verwirfst.
- **Toncutter**: mischt und säubert den Ton.

Unter **Weitere Rollen** auf der Seite **Crew** gibt es Extras, die erst zur Crew gehören, wenn du sie hinzufügst:

- **Kritiker**: sieht sich den Film an und hinterlässt Notizen auf der Zeitleiste.

Leg auf der Seite **Crew** eigene Rollen an, etwa einen Berater oder einen zweiten Kritiker, und speichere eine ganze Crew in der Bibliothek, um sie in ein anderes Projekt zu laden.

## Gespräche gehören zu Projekten

Jedes Projekt hat sein eigenes Gespräch mit dem Koordinator und mit jedem Crewmitglied. Öffnest du ein anderes Projekt, erscheinen dessen Gespräche, und die Agenten erinnern sich nur an das, was in diesem Projekt gesagt wurde. Die Crew selbst ist in jedem Projekt dieselbe, und der Koordinator kann sich weiterhin um projektübergreifende Dinge kümmern, etwa die Bibliothek, gespeicherte Crews und deine anderen Projekte. Auf dem Startbildschirm, ohne offenes Projekt, sprechen die Agenten in einem eigenen Gespräch.

**Chat leeren** oben in einem Chat vergisst es nach einer Rückfrage für das aktuelle Projekt; andere Projekte behalten ihres. Was der Agent erstellt hat, bleibt.

## Alles, was du kannst, können sie auch

Jede Schaltfläche in Imp führt einen Befehl aus, und Agenten nutzen dieselben Befehle. Was du von Hand tun kannst, kann ein Agent für dich tun, und was ein Agent getan hat, kannst du von Hand ändern.

## Freigaben und Budgets

Agenten fragen, bevor sie etwas löschen und bevor sie über das Budget ohne Rückfrage hinaus Geld ausgeben: In ihrer Leiste erscheint dann eine Freigabekarte. Bis das Budget eines Projekts aufgebraucht ist, laufen bezahlte Schritte ohne Rückfrage, damit Arbeit, die du übergibst, etwa ein ganzer Film aus einem Prompt, nicht für jeden Cent anhält. Das Budget legst du in der Ausgabenübersicht fest (die Münzen in der oberen Leiste), die auch zeigt, wie viel übrig ist: anfangs 1 $ pro Projekt, wahlweise mit einer Höchstgrenze pro Schritt. Setz es auf 0, um jeden bezahlten Schritt selbst freizugeben. Jeder Agent hat außerdem ein Budget pro Durchlauf und hört auf, wenn es erreicht ist.`,
  },
  {
    id: 'costs',
    area: 'workspace',
    title: 'Was es kostet',
    summary:
      'Wofür Geld ausgegeben wird, Preise vor dem Klick, die laufende Summe und wie du Kosten niedrig hältst.',
    body: `Imp ist kostenlos. Die Erzeugung bezahlst du bei **OpenRouter** mit deinem eigenen Schlüssel, zu den Preisen von OpenRouter. Imp selbst berechnet nichts.

## Grobe Preise mit den Einstiegsmodellen

- Die Antwort eines Agenten: ein Bruchteil eines Cents bis ein paar Cent.
- Ein Porträt oder Keyframe: etwa 1 Cent.
- Eine Stimmprobe oder eine Dialogzeile: 1 bis 2 Cent.
- Ein Soundeffekt: 1 bis 2 Cent. 30 Sekunden Musik: etwa 4 Cent.
- Ein Videoclip von 4 Sekunden: etwa 15 bis 40 Cent. Clips machen den Großteil der Kosten eines Films aus.

## Vorher und nachher

- Jede Schaltfläche, die Geld kostet, zeigt den erwarteten Preis, zum Beispiel **Clip erstellen ≈ 0,20 $**. Ein Videopreis stammt aus der Preisliste des Modells; andere Preise stammen aus dem, was dasselbe Modell dich bisher gekostet hat. Ein gestrichelter Preis ist ein grober üblicher Preis, der gilt, bis das Modell einmal benutzt wurde.
- Agenten bitten um Freigabe, sobald das Budget ohne Rückfrage eines Projekts aufgebraucht ist (anfangs 1 $, einstellbar in der Ausgabenübersicht); die Freigabekarte zeigt ebenfalls den Preis. Ein Agent hört bei seinem Budget pro Durchlauf auf.
- Die **Summe** in der oberen Leiste zeigt, was dieses Projekt gekostet hat. Öffne sie für heute, alle Projekte, eine Aufschlüsselung nach Art und die letzten Aufrufe. Du kannst auch einen Agenten fragen: „Was hat das bisher gekostet?“

## Kosten niedrig halten

- Erstelle einen Keyframe (ein Standbild, etwa 1 Cent) und prüf ihn, bevor du den Clip erstellst.
- Nimm kurze Clips; der Schnitt kann sie verlangsamen oder das letzte Bild halten.
- Nimm den Modellmix **Einstieg**, solange du lernst, und wechsle für den fertigen Film zu **Ausgewogen** oder **Beste**, über den Modell-Chip in jeder Phase.`,
  },
  {
    id: 'library',
    area: 'workspace',
    title: 'Die Bibliothek',
    summary: 'Jedes Bild, jeder Ton, jeder Clip und Text des Projekts an einem Ort.',
    body: `Die Schaltfläche **Bibliothek** in der oberen Leiste öffnet die Bibliothek des Projekts neben jeder Phase. Sie enthält jedes Porträt, jeden Keyframe, jedes Ortsbild, jeden Clip, jede Dialogzeile, jeden Ton, jedes Musikstück, jedes Audiodokument, jede Szene und Notiz, egal, wer oder was sie erstellt hat.

## Was du tun kannst

- Nach Namen, Wörtern, Tags oder Notizen suchen; nach Art filtern; Wichtiges mit einem Stern markieren.
- Eigene Bilder, Töne, Videos und Texte **importieren** oder Dateien auf die Bibliothek ziehen.
- Ein Element dorthin ziehen, wo es hingehört: ein Bild auf eine Figur, um es zu ihrem Porträt zu machen, einen Ton auf die Audiospur im Schnitt, ein Video auf eine Einstellung. Auf dem Tablet hältst du es vorher kurz gedrückt, oder du tippst es an und wählst **Verwenden in**.
- Elemente in ein anderes Projekt kopieren.
- Der Reiter **Crews** verwahrt gespeicherte Crews, die du in jedes Projekt laden kannst. Eine gespeicherte Crew behält jeden Agenten mit Modell, Budget und Websuche sowie Kopien der eigenen Rollen, die sie enthält; sie lässt sich also auch laden, nachdem eine Rolle gelöscht wurde. Lade sie, um die Crew zu ersetzen oder zu ergänzen.
- Der Reiter **Mixe** verwahrt Modellmixe: mit welchem Modell die Agenten denken und welche Modelle Bilder, Stimmen, Soundeffekte, Musik, Clips und Transkripte erstellen. Wende einen an, um alle auf einmal festzulegen; der Modell-Chip in jeder Phase tut dasselbe.

Crews und Mixe gehören zum ganzen Arbeitsbereich, nicht zu einem Projekt. Agenten nutzen dieselbe Bibliothek: Bitte den Koordinator „speicher diese Crew“ oder „speicher diese Modelle als Mix“, und er erledigt es.`,
  },
  {
    id: 'projects',
    area: 'workspace',
    title: 'Projekte',
    summary: 'Projekte anlegen, duplizieren, exportieren, importieren und zwischen ihnen kopieren.',
    body: `Die Seite **Projekte** listet deine Filme.

- **Neues Projekt** beginnt leer oder mit einer Vorlage: ein Kurzfilm, ein Musikvideo, ein Trailer oder ein Kammerspiel zu zweit.
- **Dupliziere** ein Projekt, um eine andere Richtung auszuprobieren, ohne das Original zu verlieren.
- **Exportiere** ein Projekt als eine Datei, um es zu sichern oder auf einen anderen Computer zu bringen, und **importiere** es wieder.
- **Kopiere** Figuren, Szenen, Orte und andere Teile von einem Projekt in ein anderes.
- **Alles sichern / Alles laden** bewahrt alles in Imp in einer Datei auf; siehe die Seite dazu.

Mit der Projektauswahl oben auf dem Bildschirm wechselst du von überall das offene Projekt.`,
  },
  {
    id: 'save-all',
    area: 'workspace',
    title: 'Alles sichern und Alles laden',
    summary: 'Alles in Imp in einer .zip-Datei aufbewahren und alles zurückholen.',
    body: `**Alles sichern** packt alles in Imp in eine .zip-Datei: jedes Projekt mit seinen Bildern, Stimmen, Clips und exportierten Filmen, die Bibliothek, gespeicherte Crews, Modellmixe, eigene Rollen, Gespräche mit Agenten, Optionen, Hilfe-Einstellungen und das Aussehen des Bildschirms. Dein **OpenRouter-Schlüssel ist nie darin**, die Datei kannst du also bedenkenlos auf einem Laufwerk oder in einem Cloud-Ordner aufbewahren.

**Alles laden** ersetzt alles in Imp durch den Inhalt einer solchen Datei. Nimm es, um eine Sicherung wiederherzustellen oder um deine ganze Arbeit auf einmal zwischen Browsern, Computern und dem lokalen Server umzuziehen.

## Wo du sie findest

Auf der Seite **Projekte** unter **Alles sichern / Alles laden** und unter **Optionen**. Der Koordinator kann beides auch: Bitte ihn, alles zu sichern, und Imp bietet dir die Datei zum Aufbewahren an.

## Sichern

In Chrome und Edge auf einem Computer fragt Imp, wo die Datei gespeichert werden soll. Andere Browser und Tablets speichern sie bei den Downloads. Große Arbeitsbereiche brauchen eine Weile: Die Datei wird Stück für Stück geschrieben, sodass auch viele Gigabyte hineinpassen.

## Laden

- Imp zeigt die Datei und fragt, bevor sich etwas ändert. Wähle **Vorher alles sichern**, falls du deine jetzige Arbeit vielleicht zurückwillst.
- Die ganze Datei wird geprüft, bevor sich etwas ändert. Eine beschädigte Datei ändert nichts.
- Projekte, Bibliothekseinträge und Optionen, die jetzt in Imp sind, aber nicht in der Datei, sind danach weg.
- Dein OpenRouter-Schlüssel bleibt, wie er ist.
- Die Seite lädt neu, wenn alles fertig ist.

Die Datei eines einzelnen Projekts (.imp.zip) ist keine vollständige Sicherung: Hol sie mit **Importieren** auf der Seite Projekte herein.`,
  },
  {
    id: 'where-imp-runs',
    area: 'workspace',
    title: 'Browser oder dein eigener Computer',
    summary: 'Der Unterschied, ob Imp im Browser oder auf dem lokalen Server läuft.',
    body: `Imp läuft auf zwei Arten, mit denselben Funktionen.

## Im Browser

Nichts zu installieren. Deine Projekte liegen im Speicher des Browsers auf diesem Computer. Agenten arbeiten nur, solange der Tab offen ist: Schließt du ihn, pausiert ein laufender Agent, und du kannst ihn später bitten weiterzumachen. Löschst du deine Browserdaten, sind die Projekte mit weg; exportiere also die, die dir wichtig sind.

## Auf deinem Computer

Lade Imp unter **Optionen** herunter und starte es mit Node.js 22 oder neuer: Entpacke es, führ im Ordner \`node imp.mjs\` aus und öffne die Adresse, die angezeigt wird. Deine Arbeit liegt dann als Dateien in einem Ordner von dir, mit Platz für große Medien, und Agenten arbeiten weiter, wenn der Browser geschlossen ist.

Arbeit aus dem Browser zieht nicht von selbst mit um: Exportiere das Projekt und importiere es dort, oder zieh mit **Alles sichern** und **Alles laden** alles auf einmal um.

## Dein OpenRouter-Schlüssel

Im Browser liegt der Schlüssel verschlüsselt im Speicher des Browsers, mit einem Verschlüsselungsschlüssel, den der Browser verwahrt und kein Skript lesen lässt. Auf deinem Computer verwahrt Imp den Schlüssel in einer eigenen Datei neben deinen Projekten, lesbar nur für dein Benutzerkonto, und der Browser bekommt ihn nie. So oder so kann kein Befehl und kein Agent ihn lesen, und er geht nur an OpenRouter.

## ffmpeg

Auf deinem Computer nutzt Imp **ffmpeg**, freie Software, um Filme im Hintergrund zu rendern, den Ton in Videoclips hörbar zu machen und Agenten Standbilder eines Schnitts zu zeigen. Ist ffmpeg nicht installiert, bietet Imp an, es herunterzuladen (etwa 20 bis 30 MB), in der Exportleiste im Schnitt und unter **Optionen**; Imp prüft den Download und nutzt ihn sofort. Bis dahin werden Filme im Browser in Echtzeit aufgenommen.

## Der Download ist nicht signiert

Imps Download ist nicht mit einem bezahlten Entwicklerzertifikat signiert. Startest du ihn mit \`node imp.mjs\` aus einem Terminal, fragt nichts. Warnt dein System doch vor einer Datei aus dem Download:

- **macOS**: „kann nicht geöffnet werden, da der Entwickler nicht verifiziert werden kann“. Öffne die **Systemeinstellungen**, dann **Datenschutz & Sicherheit**, scroll nach unten und drück neben dem Dateinamen auf **Dennoch öffnen**. Oder klick die Datei im Finder mit der rechten Maustaste an (Control-Klick), wähle **Öffnen** und bestätige. Das machst du einmal.
- **Windows**: „Der Computer wurde durch Windows geschützt“ (SmartScreen). Drück auf **Weitere Informationen**, dann auf **Trotzdem ausführen**. Oder klick die Zip-Datei vor dem Entpacken mit der rechten Maustaste an, wähle **Eigenschaften** und setz das Häkchen bei **Zulassen**.
- **Linux**: Nichts zu bestätigen. Startet eine Datei nicht, mach sie mit \`chmod +x\` ausführbar.`,
  },
  {
    id: 'tablet-and-keys',
    area: 'workspace',
    title: 'Tablet, Touch und Tastatur',
    summary: 'Imp auf einem Tablet im Querformat nutzen, und die Tastenkürzel.',
    body: `Imp funktioniert auf quer gehaltenen Tablets (Querformat) mit Touch. Handys werden nicht unterstützt.

## Touch

- Tippe dort, wo du mit der Maus klicken würdest. Halte ein Element kurz gedrückt, bevor du es ziehst.
- Zieh zwei Finger auseinander, um den Filmstreifen und die Zeitleiste zu zoomen.
- Auf einem schmaleren Bildschirm wechseln sich Bibliothek und Crew-Leiste ab, damit die Phase ihren Platz behält.

## Tastatur

- **Strg K**: jeden Befehl über seinen Namen ausführen.
- **Strg Umschalt L**: die Bibliothek ein- oder ausblenden.
- **Leertaste**: Abspielen und Pause im Schnitt und im Audio-Editor.
- **I** und **O**: Anfang und Ende eines Abschnitts im Schnitt markieren.
- **M**: einen Marker am Abspielkopf setzen.
- **Komma** und **Punkt**: ein Bild zurück oder vor.
- **R**: im Audio-Editor vom Mikrofon aufnehmen.`,
  },
  {
    id: 'help-and-support',
    area: 'workspace',
    title: 'Hilfe und Unterstützung',
    summary: 'Tipps, Frag Imp, diese Anleitung und ein Problem melden.',
    body: `## Tipps

Wenn du eine Phase zum ersten Mal öffnest, sagt ein kurzer Tipp, wofür sie da ist. Schließ ihn mit **Verstanden**. Kennst du dich aus, entfernt **Alle Tipps ausschalten** alle Tipps auf einmal; die Hilfe und Frag Imp bleiben. Schalte sie unter **Optionen** oder in dieser Leiste wieder ein.

## Frag Imp

Die Schaltfläche **Hilfe** öffnet **Frag Imp**. Frag alles in einfachen Worten, etwa „Wie mache ich eine Überblendung?“ oder „Was kostet diese Szene?“. Imp antwortet aus dieser Anleitung und kann dein Projekt sehen. Bitte Imp, den Schritt zu erledigen, und Imp tut es für dich, mit denselben Schaltflächen, die du hast; vor Ausgaben oder Löschungen fragt Imp nach. Imp läuft auf dem Modell des Koordinators und zählt wie jeder Agent zu deinen Ausgaben.

Der Koordinator kann Fragen zu Imp ebenfalls beantworten.

## Ein Problem melden

Etwas kaputt oder verwirrend? Öffne in der Hilfe **Ein Problem melden**, sag, was passiert ist, und drück auf **Bericht schreiben**. Imp fügt seine Version hinzu, wo es läuft, deine Bildschirmgröße und die letzten Befehle mit ihren Fehlern. Dein Schlüssel, deine Prompts und deine Geschichte kommen nie hinein. **Auf GitHub öffnen** zeigt den Bericht als neues, ausgefülltes Issue; lies ihn und drück auf Submit (dafür brauchst du ein kostenloses GitHub-Konto). Oder **Bericht kopieren** und auf anderem Weg schicken. Frag Imp kann den Bericht auch für dich schreiben.

## Die Anleitung im Web

Diese Anleitung gibt es auch als Website neben der App: **Die Anleitung im Web** unten in der Hilfe öffnet sie.`,
  },
];
