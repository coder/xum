import type { DiagramType } from "pele";

/**
 * Charts that together make Pele emit every element, attribute, style property and CSS function
 * that it emits for the 669 examples on pele.run, plus the commented cases those examples miss.
 * The Record type needs a sample for each diagram type, so a Pele upgrade that adds a type fails
 * the typecheck.
 */
export const PELE_SAMPLES: Record<DiagramType, readonly string[]> = {
  agentflow: [
    `agentflow-beta TB
  check["Tests pass?"]@{ shape: decision }
  ship["Ship it"]@{ shape: action }
  fix["Fix the build"]@{ shape: task }
  logs["Build logs"]@{ shape: refdoc }

  check -- yes --> ship
  check -- no --> fix
  fix --x check
  fix -.- logs`,
  ],
  architecture: [
    `architecture-beta
    service src1(server)[Source 1]
    service src2(server)[Source 2]
    service src3(server)[Source 3]
    service proc(server)[Processor]
    src1:B --> T:proc
    src2:B --> T:proc
    src3:B --> T:proc
    align row src1 src2 src3`,
  ],
  block: [
    `block
columns 1
  db(("DB"))
  blockArrowId6<["&nbsp;&nbsp;&nbsp;"]>(down)
  block:ID
    A
    B["A wide one in the middle"]
    C
  end
  space
  D
  ID --> D
  C --> D
  style B fill:#969,stroke:#333,stroke-width:4px`,
  ],
  c4: [
    `C4Context
  title System Context diagram for Internet Banking System
  Enterprise_Boundary(b0, "BankBoundary0") {
    Person(customerA, "Banking Customer A", "A customer of the bank, with personal bank accounts.")
    Person(customerB, "Banking Customer B")
    Person_Ext(customerC, "Banking Customer C", "desc")

    Person(customerD, "Banking Customer D", "A customer of the bank, <br/> with personal bank accounts.")

    System(SystemAA, "Internet Banking System", "Allows customers to view information about their bank accounts, and make payments.")

    Enterprise_Boundary(b1, "BankBoundary") {

      SystemDb_Ext(SystemE, "Mainframe Banking System", "Stores all of the core banking information about customers, accounts, transactions, etc.")

      System_Boundary(b2, "BankBoundary2") {
        System(SystemA, "Banking System A")
        System(SystemB, "Banking System B", "A system of the bank, with personal bank accounts. next line.")
      }

      System_Ext(SystemC, "E-mail system", "The internal Microsoft Exchange e-mail system.")
      SystemDb(SystemD, "Banking System D Database", "A system of the bank, with personal bank accounts.")

      Boundary(b3, "BankBoundary3", "boundary") {
        SystemQueue(SystemF, "Banking System F Queue", "A system of the bank.")
        SystemQueue_Ext(SystemG, "Banking System G Queue", "A system of the bank, with personal bank accounts.")
      }
    }
  }

  BiRel(customerA, SystemAA, "Uses")
  BiRel(SystemAA, SystemE, "Uses")
  Rel(SystemAA, SystemC, "Sends e-mails", "SMTP")
  Rel(SystemC, customerA, "Sends e-mails to")

  UpdateElementStyle(customerA, $fontColor="red", $bgColor="grey", $borderColor="red")
  UpdateRelStyle(customerA, SystemAA, $textColor="blue", $lineColor="blue", $offsetX="5")
  UpdateRelStyle(SystemAA, SystemE, $textColor="blue", $lineColor="blue", $offsetY="-10")
  UpdateRelStyle(SystemAA, SystemC, $textColor="blue", $lineColor="blue", $offsetY="-40", $offsetX="-50")
  UpdateRelStyle(SystemC, customerA, $textColor="red", $lineColor="red", $offsetX="-50", $offsetY="20")

  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")`,
  ],
  class: [
    `classDiagram
    namespace Company.Engineering.Backend {
        class Developer {
            +writeCode()
        }
    }
    namespace Company.Engineering.Frontend {
        class Designer {
            +createMockup()
        }
    }
    namespace Company.Engineering {
        class TechLead {
            +planSprint()
        }
    }
    TechLead --> Developer : leads
    TechLead --> Designer : leads`,
  ],
  cynefin: [
    `cynefin-beta
  title Cynefin Framework

  complex
  complicated
  clear
  chaotic`,
  ],
  er: [
    `erDiagram
    direction TB
    CAR:::someclass {
        string registrationNumber
        string make
        string model
    }
    PERSON:::someclass {
        string firstName
        string lastName
        int age
    }
    HOUSE:::someclass

    classDef someclass fill:#f96`,
  ],
  eventmodeling: [
    `eventmodeling

tf 01 ui CartUI
tf 02 cmd AddItem
tf 03 evt ItemAdded`,
  ],
  flowchart: [
    // classDef, class, style and linkStyle.
    `flowchart LR
  A[Start]:::hot --> B{Check}
  B -->|yes| C[Done]
  classDef hot fill:#f96,stroke:#333,stroke-width:4px,color:#fff
  style C fill:#bbf,stroke:#f66,stroke-width:2px,stroke-dasharray: 5 5
  linkStyle 0 stroke:#ff3,stroke-width:4px
  class B hot`,
    // A frontmatter theme. Pele ignores themeCSS.
    `---
title: Themed
config:
  theme: forest
  themeCSS: "svg { background: url(https://example.com/x.png) }"
  themeVariables:
    primaryColor: "#00ff00"
---
flowchart TD
  A --> B`,
    // Math labels.
    `flowchart LR
  A["$$x^2 + \\alpha$$"] --> B["$$\\frac{a}{b}$$"]`,
    // Label tags: <sub> and <sup> set baseline-shift, <u> and <ins> set text-decoration.
    `flowchart LR
  A["<b>bold</b> <i>italic</i> <code>code</code> H<sub>2</sub>O x<sup>2</sup> <u>under</u> <ins>ins</ins>"] --> B`,
    // Every property that Pele keeps from a chart's styles.
    `flowchart LR
  A:::all --> B
  B --> C
  classDef all fill:#f96,fill-opacity:0.5,stroke:#333,stroke-width:2px,stroke-dasharray:5 5,stroke-dashoffset:2,stroke-linecap:round,stroke-linejoin:round,stroke-opacity:0.8,opacity:0.9,rx:4,ry:4,color:#fff,font-size:16px,font-family:serif,font-weight:bold,font-style:italic,text-decoration:underline,letter-spacing:1px,word-spacing:2px
  style B fill:#9f9,stroke:#060
  linkStyle 1 stroke:#ff3,stroke-width:3px,stroke-dasharray:3 3,opacity:0.7`,
    // Every MathML attribute KaTeX sets with trust: false, including the style of \fcolorbox and \pmb.
    `flowchart LR
  A["$$\\fcolorbox{red}{yellow}{x} \\pmb{y} \\color{blue}{z} \\colorbox{pink}{w} \\cancel{c}$$"] --> B["$$\\hat{x} \\overbrace{a+b}^{n} \\left( f(a, b) \\right) \\smallint \\xrightarrow{t} \\frac{1}{2} \\sqrt[3]{v}$$"]
  B --> D["$$\\binom{n}{k} \\underbrace{c+d}_{m} \\Huge{h} \\left( a \\middle| b \\right) \\smash[b]{y} \\big[ q \\big] \\underline{u}$$"]
  D --> E["$$a \\\\ b$$"]
  B --> C["$$\\begin{array}{c|c} \\mathbb{R} & \\mathrm{d} \\\\ \\hline \\raisebox{0.2em}{r} & \\rule{1em}{1pt} \\end{array} \\tag{1}$$"]`,
  ],
  gantt: [
    `gantt
    dateFormat HH:mm
    axisFormat %H:%M
    Initial vert : vert, v1, 17:30, 2m
    Task A : 3m
    Task B : 8m
    Final vert : vert, v2, 17:58, 4m`,
  ],
  gitGraph: [
    `gitGraph
   commit
   commit
   commit`,
  ],
  info: [
    // The pele.run examples have no info diagram.
    `info`,
  ],
  ishikawa: [
    `ishikawa-beta
    Blurry Photo
    Process
        Out of focus
        Shutter speed too slow
        Protective film not removed
        Beautification filter applied
    User
        Shaky hands
    Equipment
        LENS
            Inappropriate lens
            Damaged lens
            Dirty lens
        SENSOR
            Damaged sensor
            Dirty sensor
    Environment
        Subject moved too quickly
        Too dark`,
  ],
  journey: [
    `journey
    title My working day
    section Go to work
      Make tea: 5: Me
      Go upstairs: 3: Me
      Do work: 1: Me, Cat
    section Go home
      Go downstairs: 5: Me
      Sit down: 5: Me`,
  ],
  kanban: [
    `kanban
todo[Todo]
  id3[Update Database Function]@{ ticket: MC-2037, assigned: 'knsv', priority: 'High' }`,
  ],
  mindmap: [
    `mindmap
    id)I am a cloud(`,
  ],
  packet: [
    `packet
title UDP Packet
+16: "Source Port"
+16: "Destination Port"
32-47: "Length"
48-63: "Checksum"
64-95: "Data (variable length)"`,
  ],
  pie: [
    `pie title Fish caught by the crew
    "ʻAhi" : 386
    "Mahimahi" : 85
    "Ono" : 15`,
  ],
  quadrantChart: [
    `---
config:
  quadrantChart:
    chartWidth: 400
    chartHeight: 400
  themeVariables:
    quadrant1TextFill: "ff0000"
---
quadrantChart
  x-axis Urgent --> Not Urgent
  y-axis Not Important --> "Important ❤"
  quadrant-1 Plan
  quadrant-2 Do
  quadrant-3 Delegate
  quadrant-4 Delete`,
  ],
  radar: [
    `radar-beta
  title Restaurant Comparison
  axis food["Food Quality"], service["Service"], price["Price"]
  axis ambiance["Ambiance"]

  curve a["Restaurant A"]{4, 3, 2, 4}
  curve b["Restaurant B"]{3, 4, 3, 3}
  curve c["Restaurant C"]{2, 3, 4, 2}
  curve d["Restaurant D"]{2, 2, 4, 3}

  graticule polygon
  max 5`,
  ],
  railroad: [
    `railroad-ebnf-beta
expression = term ( ( "+" | "-" ) term )* ;
term = "number" ;`,
  ],
  requirement: [
    `requirementDiagram

requirement "__test_req__" {
    id: 1
    text: "*italicized text* **bold text**"
    risk: high
    verifymethod: test
}`,
  ],
  sankey: [
    `sankey

Bio-conversion,Losses,26.862

Bio-conversion,Solid,280.322

Bio-conversion,Gas,81.144`,
  ],
  sequence: [
    // accTitle and accDescr, which Pele writes into <title> and <desc>.
    `sequenceDiagram
  accTitle: Seq title
  accDescr: Seq description
  %% a comment
  rect rgb(191, 223, 255)
  Alice->>Bob: Hi <!-- not a comment -->
  end`,
    // The CSS color functions a sequence rect takes.
    `sequenceDiagram
  rect rgba(0, 0, 255, 0.1)
  Alice->>Bob: Hi
  end
  rect hsl(120, 50%, 50%)
  Bob->>Alice: Hello
  end`,
  ],
  state: [
    `stateDiagram-v2
    stateId`,
  ],
  swimlane: [
    `swimlane-beta
  subgraph Sales
    lead[Qualify lead]
    quote[Prepare quote]
  end`,
  ],
  timeline: [
    `timeline
    title History of Social Media Platform
    2002 : LinkedIn
    2004 : Facebook : Google
    2005 : YouTube
    2006 : Twitter`,
  ],
  treemap: [
    `treemap-beta
"Category A"
    "Item A1": 10
    "Item A2": 20
"Category B"
    "Item B1": 15
    "Item B2": 25`,
  ],
  treeView: [
    `treeView-beta
    "packages"
        "mermaid"
            "src"
        "parser"`,
  ],
  usecase: [
    `usecase-beta
actor Customer:::external
Checkout("Checkout"):::critical
systemBoundary Account
  Profile[Edit profile]
end
json Session@{ "active": true }:::data
Customer --> Checkout
Checkout --> Profile
Profile --> Session
classDef default stroke:#7f8ea3
classDef external,critical stroke-width:3px
class Customer,Checkout external,critical
class Account,Session data
style Checkout stroke:#c33,stroke-width:4px
style Account stroke:#536878`,
  ],
  venn: [
    `venn-beta
  set A["Alpha"]
  set B["Beta"]
  union A,B["AB"]`,
  ],
  wardley: [
    `wardley-beta
title Custom Size
size [800, 1000]`,
  ],
  xychart: [
    `xychart
    title "Quarterly Performance"
    x-axis [Q1, Q2, Q3, Q4]
    y-axis "Revenue ($M)" 0 --> 100
    line [25 "Launch", 45, 72, 90 "Target Hit"]`,
  ],
};
