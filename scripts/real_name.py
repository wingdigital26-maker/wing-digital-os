"""One rule for "is this a real person's name a caller can ask for".

The dial list only shows leads with a named contact, so the name has to be a
name. A lot of contact_name values were derived from email local-parts and are
inboxes or businesses, not people: "Orders", "Contactus", "Jerryssigns",
"Cjones". clean_name() returns a tidy name, or None when there is no person.

Rules:
  - two or more words: kept, unless a word is an inbox/role/business word.
    Trailing titles (", Managing Member") and "Mr." prefixes are stripped, and
    "A / B" keeps the first person.
  - one word: kept only when it is a known first name. "Cjones" style
    initial+surname handles are not something you can ask for on the phone.
"""
from __future__ import annotations

import re

FIRST_NAMES = set("""
aaron abel abigail abraham adam adan adrian adriana agustin aidan aimee al alan albert alberto
alejandro alex alexa alexander alexis alfonso alfred alfredo alice alicia allan allen allie
allison alma alvaro alvin alyssa amanda amber amy ana andre andrea andres andrew andy angel
angela angelica angie anita ann anna anne annie anthony antonio april armando arnold art arthur
arturo ashley aubrey audrey barbara barry beau becky ben benjamin bernard beth betty beverly
bill billy blake bo bob bobby bonnie brad bradley brady brandi brandon brandy brenda brent brett
brian brittany brooke bruce bryan bryce caleb calvin cameron candace carl carla carlos carmen
carol caroline carolyn carrie carson casey cassie catherine cathy cecil cesar chad chance charles
charlie charlotte chase chaun chelsea cheryl chris christi christian christie christina christine
christopher christy chuck cindy claire clarence clark claudia clay clayton cliff clifford clint
clinton clyde cody colby cole colin colt connie connor corey cory courtney craig cristina crystal
curtis cynthia daisy dale dalton damian damon dan dana dani daniel danielle danny darin
darius darla darrell darren darryl dave david dawn dean deanna debbie deborah debra delia dennis
derek derrick desiree devin devon diana diane diego dillon dina dolores dominic don donald donna
donnie doris dorothy doug douglas drew duane dustin dwayne dwight dylan earl ed eddie edgar edith
edna eduardo edward edwin efrain eileen elaine elena eli elias elizabeth ellen elmer emily emma
emmanuel enrique eric erica erick erik erika erin ernest ernesto esteban esther ethan eugene eva
evan evaristo evelyn fabian faith felipe felix fernando floyd frances francis francisco frank
frankie franklin fred freddie freddy frederick gabriel gabriela gail garrett gary gavin gene
geoff geoffrey george gerald gerardo gilbert gina ginger glen glenn gloria gordon grace grady
graham grant greg gregg gregory greta guadalupe guillermo gus gustavo guy haley hannah harold
harry harvey hayden heather hector heidi helen henry herbert herman hilda holly hope howard hugo
hunter ian ignacio irene iris isaac isabel ismael israel ivan ivana jack jackie jackson jacob
jacqueline jacqui jaime jake james jamie jan jane janet janice jared jarrod jasmine jason javier
jay jean jeanette jeff jeffery jeffrey jenna jennifer jenny jeremiah jeremy jerome jerry jesse
jessica jessie jesus jill jim jimmy jo joan joann joanna joanne joaquin jody joe joel joey johanna
john johnathan johnnie johnny jon jonathan jordan jorge jose joseph josh joshua josie josue joy
joyce juan juanita judith judy julia julian julie julio justin kaitlyn kara karen kari karina
karl karla kate katherine kathleen kathryn kathy katie katrina kay kayla keith kelli kelly kelsey
ken kendra kenneth kenny kent kerry kevin kim kimberly kirk kris krista kristen kristi kristin
kristina kristy kurt kyle lacey lance landon larry laura lauren laurie lawrence leah lee leo leon
leonard leonardo leroy leslie leticia levi lewis liam lillian linda lindsay lindsey lisa lloyd
logan lois lonnie lorena lorenzo loretta lori lorraine louis lucas lucia lucy luis luke lupe
lydia lynn mackenzie madison mallory mandy manuel marc marcia marco marcos marcus margaret maria
marie marilyn mario marisol marissa mark marlene marsha marshall martha martin marty marvin mary
mason mateo matt matthew maureen mauricio max maxine mayra megan meghan melanie melinda melissa
melvin mercedes meredith micah michael micheal michele michelle miguel mikala mike mildred miles
milton mindy miranda misty mitch mitchell moises molly monica monique monte morgan morris moses
myra nancy naomi natalie natasha nate nathan nathaniel neal ned neil nelson nestor nicholas nick
nicolas nicole nina noah noe noel nolan nora norma norman octavio olga oliver olivia omar orlando
oscar owen pablo paige pam pamela parker pat patricia patrick patsy patty paul paula pauline
pedro peggy penny perry pete peter phil philip phillip phyllis preston priscilla rachel rafael
ralph rami ramiro ramon randall randy raquel raul ray raymond rebecca reggie regina reginald rene
renee rex rey reynaldo rhonda ricardo richard rick rickey ricky rigoberto riley rita rob robert
roberta roberto robin rochelle rocky rod roderick rodney rodolfo rodrigo roger rogelio roland
rolando roman ron ronald ronnie rosa rose rosemary ross roxanne roy ruben ruby rudy russ russell
rusty ruth ryan sabrina sal sally salvador sam samantha sammy samuel sandi sandra sandy santiago
santos sara sarah saul savannah scott sean sebastian sergio seth shane shannon shari sharon shaun
shawn shawna sheila shelby shelia shelley shelly sheri sherri sherrie sherry sheryl shirley sidney
silvia simon sofia sonia sonya sophia spencer stacey stacy stan stanley stella stephanie stephen
steve steven stuart sue summer susan susie suzanne sylvia tamara tami tammy tanner tanya tara
taylor ted teresa teri terrance terrence terri terry thelma theodore theresa thomas tiffany tim
timothy tina toby todd tom tomas tommy toni tony tonya tracey traci tracy travis trent trevor trey
tricia tristan troy tyler tyrone valerie vanessa vera vernon veronica vicente vicki vickie vicky
victor victoria vince vincent viola violet virgil virginia vivian wade wallace walter wanda
warren wayne wendy wes wesley whitney wilbur will willard william willie wilson winston wyatt
xavier yesenia yolanda yvette yvonne zach zachary zack zane zoe
""".split())

# Words that mean "this is an inbox or a business, not a person".
JUNK_WORDS = set("""
info contact contacts contactus sales sale support admin office offices orders order quote quotes
service services team customer customercare care help helpdesk hello billing accounts accounting
marketing media press careers jobs recruiting hr inquiry inquire inquiries estimate estimates
estimating estimation dispatch dispatcher shipping delivery freight warehouse webmaster web
mail email owner manager management company corporate llc inc dfw improved unknown none na
""".split())

TITLE_TAIL = re.compile(
    r",\s*(managing member|member|owner|president|director|ceo|cfo|coo|founder|partner|"
    r"principal|manager|mba|co-owners?|vp|vice president)\b.*$",
    re.I,
)
HONORIFIC = re.compile(r"^(mr|mrs|ms|miss|dr)\.?\s+", re.I)


def clean_name(raw: str | None) -> str | None:
    if not raw:
        return None
    n = str(raw).strip()
    # "A / B" and "A and B": the first person is who you ask for.
    n = re.split(r"\s+/\s+|\s+and\s+|\s*&\s*", n)[0].strip()
    n = TITLE_TAIL.sub("", n).strip(" ,")
    n = HONORIFIC.sub("", n).strip()
    if not n or len(n) > 60 or re.search(r"[\d@]", n):
        return None
    words = [w for w in re.split(r"\s+", n) if w]
    bare = [re.sub(r"[^a-z]", "", w.lower()) for w in words]
    if any(b in JUNK_WORDS for b in bare):
        return None
    if len(words) == 1:
        if bare[0] not in FIRST_NAMES:
            return None
        return words[0][:1].upper() + words[0][1:].lower()
    # "JONATHAN MCKEE" -> "Jonathan Mckee"; mixed case is left as typed.
    if n.isupper():
        n = n.title()
    return n


if __name__ == "__main__":
    import sys

    for a in sys.argv[1:]:
        print(repr(a), "->", repr(clean_name(a)))
